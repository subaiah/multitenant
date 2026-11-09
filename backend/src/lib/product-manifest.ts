/**
 * An external product's manifest (docs/PRODUCT_INTEGRATION.md): validated,
 * then imported into the catalogue in one transaction. Creates the
 * application the first time; afterwards updates it, keeping its sign-in
 * credentials. Permissions no longer in the manifest are reported, never
 * removed: organizations' roles may still hold them.
 */
import { z } from 'zod';
import { controlDb } from './prisma.js';
import { allowedUri, newClientId, newClientSecret } from './oidc/uris.js';
import { applicationPermissionProblem, forgetApplicationPermissions } from './application-permissions.js';
import { userEventsChanged } from './product-user-events.js';
import { DEFAULT_ACCESS_TOKEN_LIFETIME } from './oidc/provider.js';
import { AppError } from '../middleware/error-handler.js';
import { refreshProductCatalog } from './product-catalog.js';
import { KIT_AUDIT_EVENTS } from '../kit/audit-events.js';
import { KIT_NOTIFICATION_TYPES } from '../kit/notification-types.js';
import { callbackChanged, callbackUrlSchema, newCallbackSecret } from './product-lifecycle.js';

const uri = z.string().max(2000).refine(allowedUri, 'Use an https:// address (or http://localhost while developing), without a #fragment');
const relativePath = z.string().max(500).regex(/^\/(?!\/)[^\s#]*$/, 'A path starting with / (no #fragment)');

// The fields every version has (version 1's)
const commonFields = {
    productId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,49}$/, 'Lowercase letters, digits and hyphens, 2–50 characters'),
    name: z.string().trim().min(2).max(100),
    description: z.string().max(500).optional(),
    version: z.string().trim().min(1).max(50),
    baseUrl: uri.refine((v) => {
      const u = new URL(v);
      return (u.pathname === '/' || u.pathname === '') && !u.search;
    }, 'Just the address, without a path or query (e.g. https://appforge.example.com)'),
    signIn: z.object({
      clientType: z.enum(['CONFIDENTIAL', 'PUBLIC']),
      redirectUris: z.array(uri).min(1).max(10),
      postLogoutRedirectUris: z.array(uri).max(10).optional(),
      openPath: relativePath.optional(),
      backchannelLogoutUri: callbackUrlSchema.optional(),
      accessTokenLifetime: z.number().int().min(60).max(86_400).optional(),
    }),
    provisioning: z.object({ callbackUrl: callbackUrlSchema, deletesDataOnDeprovision: z.boolean().default(false), userEvents: z.boolean().default(false) }).optional(),
    permissions: z.array(z.object({ name: z.string().max(100), description: z.string().trim().min(1).max(200) })).max(100).default([]),
    menu: z
      .array(z.object({
        label: z.string().trim().min(1).max(40),
        path: relativePath,
        icon: z.string().max(40).optional(),
        permission: z.string().max(100).optional(),
      }))
      .max(20)
      .default([]),
};

// Version 2 (docs/hub/MANIFEST_V2.md): what's supported so far
const declaredName = z.string().max(100);
const v2Fields = {
  kind: z.enum(['specific', 'generic']).default('specific'),
  platformServices: z.object({
    notifications: z.array(z.object({
      type: declaredName,
      label: z.string().trim().min(1).max(100),
      description: z.string().trim().max(200).optional(),
      defaultChannels: z.array(z.enum(['in_app', 'email'])).max(2).default(['in_app']),
    })).max(50).default([]),
    auditEvents: z.array(z.object({ type: declaredName, label: z.string().trim().min(1).max(100) })).max(100).default([]),
  }).default({ notifications: [], auditEvents: [] }),
};
/** Version 2 fields this platform doesn't take yet (refused, not dropped) */
export const V2_NOT_YET = ['requires', 'integratesWith', 'api', 'consumes', 'embeds', 'events', 'resources', 'limits', 'usage', 'health'] as const;

/** <productId>.<name>: lowercase letters, digits, _ and -, in dot-separated parts */
const declaredTypeProblem = (productId: string, type: string): string | null => {
  if (!type.startsWith(`${productId}.`)) return `must start with "${productId}."`;
  if (!/^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)*$/.test(type.slice(productId.length + 1))) return 'use lowercase letters, digits, _ and -, in dot-separated parts';
  if (type in KIT_AUDIT_EVENTS || type in KIT_NOTIFICATION_TYPES) return "is one of the platform's own types";
  return null;
};

export const manifestSchema = z
  .discriminatedUnion('manifestVersion', [
    z.object({ manifestVersion: z.literal(1), ...commonFields }),
    z.object({ manifestVersion: z.literal(2), ...commonFields, ...v2Fields }),
  ])
  .superRefine((m, ctx) => {
    if (m.manifestVersion === 2) {
      const seen = new Set<string>();
      const lists = [['notifications', m.platformServices.notifications], ['auditEvents', m.platformServices.auditEvents]] as const;
      for (const [list, items] of lists) {
        items.forEach((t, i) => {
          const problem = declaredTypeProblem(m.productId, t.type);
          if (problem) ctx.addIssue({ code: 'custom', path: ['platformServices', list, i, 'type'], message: `"${t.type}" ${problem}` });
          if (seen.has(t.type)) ctx.addIssue({ code: 'custom', path: ['platformServices', list, i, 'type'], message: `"${t.type}" is declared twice` });
          seen.add(t.type);
        });
      }
    }
    const names = new Set<string>();
    m.permissions.forEach((p, i) => {
      const problem = applicationPermissionProblem(m.productId, p.name);
      if (problem) ctx.addIssue({ code: 'custom', path: ['permissions', i, 'name'], message: `"${p.name}": ${problem}` });
      if (names.has(p.name)) ctx.addIssue({ code: 'custom', path: ['permissions', i, 'name'], message: `"${p.name}" is listed twice` });
      names.add(p.name);
    });
    m.menu.forEach((item, i) => {
      if (item.permission && !names.has(item.permission)) {
        ctx.addIssue({ code: 'custom', path: ['menu', i, 'permission'], message: `"${item.permission}" isn't one of the manifest's permissions` });
      }
    });
  });

export type ProductManifest = z.infer<typeof manifestSchema>;

/** The manifest's problems as readable lines (field: message) */
export function manifestProblems(input: unknown): string[] | null {
  const extra: string[] = [];
  if (input && typeof input === 'object') {
    const raw = input as Record<string, unknown>;
    // Refused rather than silently dropped, so nobody thinks they're in effect
    const v2Only = ['kind', 'platformServices', ...V2_NOT_YET].filter((k) => k in raw);
    if (raw.manifestVersion === 1 && v2Only.length) extra.push(...v2Only.map((k) => `${k}: needs "manifestVersion": 2`));
    if (raw.manifestVersion === 2) {
      extra.push(...V2_NOT_YET.filter((k) => k in raw).map((k) => `${k}: not supported by this platform yet (docs/hub/MANIFEST_V2.md); leave it out for now`));
    }
  }
  const parsed = manifestSchema.safeParse(input);
  const problems = [...extra, ...(parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.') || 'manifest'}: ${i.message}`))];
  return problems.length ? problems : null;
}

export interface ImportResult {
  application: { id: string; key: string; name: string; version: string };
  created: boolean;
  clientId: string;
  /** Only when it was just made (first import, or switched to a confidential client) */
  clientSecret?: string;
  /** Signs lifecycle events; only when it was just made (callback address set for the first time) */
  callbackSigningSecret?: string;
  /** Organizations told now (organization.entitled), when a callback address was just added */
  organizationsTold?: number;
  permissions: { added: string[]; updated: string[]; notInManifest: string[] };
  /** Declared notification and audit event types (manifest v2); a version 1 manifest leaves them alone */
  platformServices: { added: string[]; updated: string[]; retired: string[] } | { leftAlone: true };
  menuItems: number;
  /** What changed in the catalogue entry and its sign-in, { field: [before, after] } (audited) */
  changes: Record<string, [unknown, unknown]>;
  /** A dry run: what would happen; nothing was saved and no secrets were made */
  dryRun?: true;
}

export interface ImportOptions {
  /** Check and report only */
  dryRun?: boolean;
  /** Switching between CONFIDENTIAL and PUBLIC clients must be asked for explicitly */
  confirmClientTypeChange?: boolean;
}

class DryRun extends Error {
  constructor(readonly result: unknown) {
    super('dry run');
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function importManifest(input: unknown, options: ImportOptions = {}): Promise<ImportResult> {
  const problems = manifestProblems(input);
  if (problems) throw new AppError(`The manifest has problems:\n${problems.join('\n')}`, 400, true, 'INVALID_MANIFEST');
  const m = manifestSchema.parse(input);

  // Permission names are unique across the platform
  const taken = await controlDb.permission.findMany({
    where: { name: { in: m.permissions.map((p) => p.name) }, NOT: { application: { key: m.productId } } },
    select: { name: true },
  });
  if (taken.length) throw new AppError(`Already used by another application: ${taken.map((t) => t.name).join(', ')}`, 409);
  // So are declared types (they start with the product id, but an older product may have the same prefix)
  const services = m.manifestVersion === 2 ? m.platformServices : null;
  const declared = services ? [
    ...services.notifications.map((t) => ({ kind: 'notification', type: t.type, label: t.label, description: t.description ?? null, defaultInApp: t.defaultChannels.includes('in_app'), defaultEmail: t.defaultChannels.includes('email') })),
    ...services.auditEvents.map((t) => ({ kind: 'audit', type: t.type, label: t.label, description: null, defaultInApp: true, defaultEmail: false })),
  ].map((t, position) => ({ ...t, position })) : [];
  const takenTypes = await controlDb.productDeclaredType.findMany({
    where: { type: { in: declared.map((t) => t.type) }, NOT: { application: { key: m.productId } } },
    select: { type: true },
  });
  if (takenTypes.length) throw new AppError(`Already declared by another application: ${takenTypes.map((t) => t.type).join(', ')}`, 409);

  let result;
  try {
    result = await controlDb.$transaction(async (tx) => {
      const existing = await tx.applicationRegistry.findUnique({ where: { key: m.productId }, include: { signIn: true, permissions: true } });
      // Switching client type changes how the application authenticates (and drops or makes a secret)
      if (existing?.signIn && existing.signIn.clientType !== m.signIn.clientType && !options.confirmClientTypeChange) {
        throw new AppError(
          `This switches ${existing.name} from a ${existing.signIn.clientType} to a ${m.signIn.clientType} client${m.signIn.clientType === 'PUBLIC' ? ', which removes its client secret' : ', which gives it a new client secret'}. Import again with confirmClientTypeChange to go ahead.`,
          409, true, 'CLIENT_TYPE_CHANGE',
        );
      }
      // The manifest says where lifecycle events go; without provisioning, nowhere
      const callbackSecret = m.provisioning && !existing?.callbackSigningSecret ? newCallbackSecret() : undefined;
      const fields = {
        name: m.name, description: m.description ?? null, version: m.version, baseUrl: m.baseUrl.replace(/\/+$/, ''), manifestImportedAt: new Date(),
        provisioningCallbackUrl: m.provisioning?.callbackUrl ?? null,
        deletesDataOnDeprovision: m.provisioning?.deletesDataOnDeprovision ?? false,
        userEvents: m.provisioning?.userEvents ?? false,
        manifestVersion: m.manifestVersion,
        // A version 1 manifest leaves the kind as it was
        ...(m.manifestVersion === 2 && { kind: m.kind }),
        ...(callbackSecret && { callbackSigningSecret: callbackSecret }),
      };
      const app = existing
        ? await tx.applicationRegistry.update({ where: { id: existing.id }, data: fields })
        : await tx.applicationRegistry.create({ data: { key: m.productId, status: 'ACTIVE', ...fields } });

      // Sign-in: the same credentials across imports; a secret only when a confidential client has none
      const before = existing?.signIn;
      const confidential = m.signIn.clientType === 'CONFIDENTIAL';
      const secret = confidential && !before?.oidcClientSecret ? newClientSecret() : undefined;
      const signInFields = {
        // A first import turns sign-in on; after that, platform staff's choice stands
        enabled: before ? before.enabled : true,
        clientType: m.signIn.clientType,
        redirectUris: [...new Set(m.signIn.redirectUris)],
        postLogoutRedirectUris: [...new Set(m.signIn.postLogoutRedirectUris ?? [])],
        initiateLoginUri: m.signIn.openPath ? `${fields.baseUrl}${m.signIn.openPath}` : null,
        backchannelLogoutUri: m.signIn.backchannelLogoutUri ?? null,
        accessTokenLifetime: m.signIn.accessTokenLifetime ?? DEFAULT_ACCESS_TOKEN_LIFETIME,
        ...(secret && { oidcClientSecret: secret, secretCreatedAt: new Date() }),
        ...(!confidential && { oidcClientSecret: null, secretCreatedAt: null }),
      };
      const signIn = await tx.applicationSignIn.upsert({
        where: { applicationId: app.id },
        create: { applicationId: app.id, clientId: newClientId(), ...signInFields },
        update: signInFields,
      });

      // Permissions: add new, refresh descriptions; report the rest
      const had = new Map((existing?.permissions ?? []).map((p) => [p.name, p]));
      const added: string[] = [];
      const updated: string[] = [];
      for (const p of m.permissions) {
        const [resource, action] = p.name.split(':');
        const old = had.get(p.name);
        if (!old) {
          await tx.permission.create({ data: { applicationId: app.id, name: p.name, description: p.description, resource, action } });
          added.push(p.name);
        } else if (old.description !== p.description) {
          await tx.permission.update({ where: { id: old.id }, data: { description: p.description } });
          updated.push(p.name);
        }
      }
      const listed = new Set(m.permissions.map((p) => p.name));
      const notInManifest = [...had.keys()].filter((n) => !listed.has(n)).sort();

      // Menu: replaced
      await tx.applicationMenuItem.deleteMany({ where: { applicationId: app.id } });
      if (m.menu.length) {
        await tx.applicationMenuItem.createMany({
          data: m.menu.map((item, order) => ({ applicationId: app.id, label: item.label, path: item.path, icon: item.icon ?? null, permission: item.permission ?? null, order })),
        });
      }

      // Declared types: added or refreshed; gone from the manifest, retired (still known, can't be used)
      let platformServices: ImportResult['platformServices'] = { leftAlone: true };
      if (services) {
        const had = new Map((await tx.productDeclaredType.findMany({ where: { applicationId: app.id } })).map((t) => [t.type, t]));
        const ps = { added: [] as string[], updated: [] as string[], retired: [] as string[] };
        for (const t of declared) {
          const old = had.get(t.type);
          if (!old) {
            await tx.productDeclaredType.create({ data: { applicationId: app.id, ...t } });
            ps.added.push(t.type);
          } else if (old.retiredAt || old.kind !== t.kind || old.label !== t.label || old.description !== t.description || old.defaultInApp !== t.defaultInApp || old.defaultEmail !== t.defaultEmail) {
            await tx.productDeclaredType.update({ where: { id: old.id }, data: { ...t, retiredAt: null } });
            ps.updated.push(t.type);
          } else if (old.position !== t.position) {
            // Only moved: not a change worth reporting
            await tx.productDeclaredType.update({ where: { id: old.id }, data: { position: t.position } });
          }
        }
        const listedTypes = new Set(declared.map((t) => t.type));
        for (const old of had.values()) {
          if (!listedTypes.has(old.type) && !old.retiredAt) {
            await tx.productDeclaredType.update({ where: { id: old.id }, data: { retiredAt: new Date() } });
            ps.retired.push(old.type);
          }
        }
        platformServices = ps;
      }

      // What changed, for the audit log and the dry run (never secrets)
      const was = {
        name: existing?.name ?? null, version: existing?.version ?? null, baseUrl: existing?.baseUrl ?? null, kind: existing?.kind ?? null,
        callbackUrl: existing?.provisioningCallbackUrl ?? null, deletesDataOnDeprovision: existing?.deletesDataOnDeprovision ?? false, userEvents: existing?.userEvents ?? false,
        clientType: before?.clientType ?? null, redirectUris: before?.redirectUris ?? [], postLogoutRedirectUris: before?.postLogoutRedirectUris ?? [],
        openUrl: before?.initiateLoginUri ?? null, signInEnabled: before?.enabled ?? null,
        backchannelLogoutUri: before?.backchannelLogoutUri ?? null, accessTokenLifetime: before?.accessTokenLifetime ?? null,
      };
      const now = {
        name: app.name, version: app.version, baseUrl: app.baseUrl, kind: app.kind, callbackUrl: fields.provisioningCallbackUrl, deletesDataOnDeprovision: fields.deletesDataOnDeprovision, userEvents: fields.userEvents,
        clientType: signIn.clientType, redirectUris: signIn.redirectUris, postLogoutRedirectUris: signIn.postLogoutRedirectUris, openUrl: signIn.initiateLoginUri, signInEnabled: signIn.enabled,
        backchannelLogoutUri: signIn.backchannelLogoutUri, accessTokenLifetime: signIn.accessTokenLifetime,
      };
      const changes = Object.fromEntries(
        (Object.keys(now) as (keyof typeof now)[]).filter((k) => !same(was[k], now[k])).map((k) => [k, [was[k], now[k]] as [unknown, unknown]]),
      );

      const outcome = {
        application: { id: app.id, key: app.key, name: app.name, version: app.version },
        created: !existing,
        changes,
        clientId: signIn.clientId,
        ...(secret && { clientSecret: secret }),
        ...(callbackSecret && { callbackSigningSecret: callbackSecret }),
        hadCallback: !!existing?.provisioningCallbackUrl,
        hadUserEvents: existing?.userEvents ?? false,
        permissions: { added, updated, notInManifest },
        platformServices,
        menuItems: m.menu.length,
      };
      // A dry run: everything checked and worked out, then rolled back
      if (options.dryRun) throw new DryRun(outcome);
      return outcome;
    });
  } catch (err) {
    if (err instanceof DryRun) {
      const { clientSecret: _s, callbackSigningSecret: _c, hadCallback: _h, hadUserEvents: _u, ...plan } = err.result as ImportResult & { hadCallback: boolean; hadUserEvents: boolean };
      return { ...plan, ...(plan.created && { clientId: '(made on import)', application: { ...plan.application, id: '(made on import)' } }), dryRun: true };
    }
    // Two imports of the same new product at once: one wins
    if ((err as { code?: string }).code === 'P2002') {
      throw new AppError('Another import of this product ran at the same time. Import again to apply this one.', 409, true, 'CONCURRENT_IMPORT');
    }
    throw err;
  }
  forgetApplicationPermissions();
  await refreshProductCatalog(true);
  // Organizations that have it on and weren't told yet are told now
  const { hadCallback, hadUserEvents, ...rest } = result;
  const told = await callbackChanged(result.application.id, hadCallback, !!m.provisioning);
  await userEventsChanged(result.application.id, hadUserEvents, m.provisioning?.userEvents ?? false);
  return { ...rest, ...(told && { organizationsTold: told }) };
}

/** An application's current settings as a manifest (to start one, or compare) */
export async function exportManifest(applicationId: string): Promise<ProductManifest> {
  const app = await controlDb.applicationRegistry.findUnique({
    where: { id: applicationId },
    include: {
      signIn: true, permissions: { orderBy: { name: 'asc' } }, menuItems: { orderBy: { order: 'asc' } },
      declaredTypes: { where: { retiredAt: null }, orderBy: [{ position: 'asc' }, { type: 'asc' }] },
    },
  });
  if (!app) throw new AppError('Application not found', 404);
  const base = app.baseUrl ?? '';
  const openPath = app.signIn?.initiateLoginUri && base && app.signIn.initiateLoginUri.startsWith(base) ? app.signIn.initiateLoginUri.slice(base.length) || '/' : undefined;
  const common = {
    productId: app.key,
    name: app.name,
    ...(app.description && { description: app.description }),
    version: app.version,
    baseUrl: base,
    signIn: {
      clientType: app.signIn?.clientType ?? 'CONFIDENTIAL',
      redirectUris: app.signIn?.redirectUris ?? [],
      ...(app.signIn?.postLogoutRedirectUris.length && { postLogoutRedirectUris: app.signIn.postLogoutRedirectUris }),
      ...(openPath && { openPath }),
      ...(app.signIn?.backchannelLogoutUri && { backchannelLogoutUri: app.signIn.backchannelLogoutUri }),
      ...(app.signIn && app.signIn.accessTokenLifetime !== DEFAULT_ACCESS_TOKEN_LIFETIME && { accessTokenLifetime: app.signIn.accessTokenLifetime }),
    },
    ...(app.provisioningCallbackUrl && { provisioning: { callbackUrl: app.provisioningCallbackUrl, deletesDataOnDeprovision: app.deletesDataOnDeprovision, userEvents: app.userEvents } }),
    permissions: app.permissions.map((p) => ({ name: p.name, description: p.description ?? p.name })),
    menu: app.menuItems.map((i) => ({ label: i.label, path: i.path, ...(i.icon && { icon: i.icon }), ...(i.permission && { permission: i.permission }) })),
  };
  if (app.manifestVersion !== 2) return { manifestVersion: 1, ...common };
  return {
    manifestVersion: 2,
    ...common,
    kind: app.kind === 'generic' ? 'generic' : 'specific',
    platformServices: {
      notifications: app.declaredTypes.filter((t) => t.kind === 'notification').map((t) => ({
        type: t.type, label: t.label, ...(t.description && { description: t.description }),
        defaultChannels: [...(t.defaultInApp ? ['in_app' as const] : []), ...(t.defaultEmail ? ['email' as const] : [])],
      })),
      auditEvents: app.declaredTypes.filter((t) => t.kind === 'audit').map((t) => ({ type: t.type, label: t.label })),
    },
  };
}
