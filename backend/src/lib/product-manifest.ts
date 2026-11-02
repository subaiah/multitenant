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
import { AppError } from '../middleware/error-handler.js';
import { callbackChanged, callbackUrlSchema, newCallbackSecret } from './product-lifecycle.js';

const uri = z.string().max(2000).refine(allowedUri, 'Use an https:// address (or http://localhost while developing), without a #fragment');
const relativePath = z.string().max(500).regex(/^\/(?!\/)[^\s#]*$/, 'A path starting with / (no #fragment)');

export const manifestSchema = z
  .object({
    manifestVersion: z.literal(1),
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
    }),
    provisioning: z.object({ callbackUrl: callbackUrlSchema, deletesDataOnDeprovision: z.boolean().default(false) }).optional(),
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
  })
  .superRefine((m, ctx) => {
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
  const parsed = manifestSchema.safeParse(input);
  if (parsed.success) return null;
  return parsed.error.issues.map((i) => `${i.path.join('.') || 'manifest'}: ${i.message}`);
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
  menuItems: number;
}

export async function importManifest(input: unknown): Promise<ImportResult> {
  const problems = manifestProblems(input);
  if (problems) throw new AppError(`The manifest has problems:\n${problems.join('\n')}`, 400, true, 'INVALID_MANIFEST');
  const m = manifestSchema.parse(input);

  // Permission names are unique across the platform
  const taken = await controlDb.permission.findMany({
    where: { name: { in: m.permissions.map((p) => p.name) }, NOT: { application: { key: m.productId } } },
    select: { name: true },
  });
  if (taken.length) throw new AppError(`Already used by another application: ${taken.map((t) => t.name).join(', ')}`, 409);

  const result = await controlDb.$transaction(async (tx) => {
    const existing = await tx.applicationRegistry.findUnique({ where: { key: m.productId }, include: { signIn: true, permissions: true } });
    // The manifest says where lifecycle events go; without provisioning, nowhere
    const callbackSecret = m.provisioning && !existing?.callbackSigningSecret ? newCallbackSecret() : undefined;
    const fields = {
      name: m.name, description: m.description ?? null, version: m.version, baseUrl: m.baseUrl.replace(/\/+$/, ''), manifestImportedAt: new Date(),
      provisioningCallbackUrl: m.provisioning?.callbackUrl ?? null,
      deletesDataOnDeprovision: m.provisioning?.deletesDataOnDeprovision ?? false,
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
      enabled: true,
      clientType: m.signIn.clientType,
      redirectUris: [...new Set(m.signIn.redirectUris)],
      postLogoutRedirectUris: [...new Set(m.signIn.postLogoutRedirectUris ?? [])],
      initiateLoginUri: m.signIn.openPath ? `${fields.baseUrl}${m.signIn.openPath}` : null,
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

    return {
      application: { id: app.id, key: app.key, name: app.name, version: app.version },
      created: !existing,
      clientId: signIn.clientId,
      ...(secret && { clientSecret: secret }),
      ...(callbackSecret && { callbackSigningSecret: callbackSecret }),
      hadCallback: !!existing?.provisioningCallbackUrl,
      permissions: { added, updated, notInManifest },
      menuItems: m.menu.length,
    };
  });
  forgetApplicationPermissions();
  // Organizations that have it on and weren't told yet are told now
  const { hadCallback, ...rest } = result;
  const told = await callbackChanged(result.application.id, hadCallback, !!m.provisioning);
  return { ...rest, ...(told && { organizationsTold: told }) };
}

/** An application's current settings as a manifest (to start one, or compare) */
export async function exportManifest(applicationId: string): Promise<ProductManifest> {
  const app = await controlDb.applicationRegistry.findUnique({
    where: { id: applicationId },
    include: { signIn: true, permissions: { orderBy: { name: 'asc' } }, menuItems: { orderBy: { order: 'asc' } } },
  });
  if (!app) throw new AppError('Application not found', 404);
  const base = app.baseUrl ?? '';
  const openPath = app.signIn?.initiateLoginUri && base && app.signIn.initiateLoginUri.startsWith(base) ? app.signIn.initiateLoginUri.slice(base.length) || '/' : undefined;
  return {
    manifestVersion: 1,
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
    },
    ...(app.provisioningCallbackUrl && { provisioning: { callbackUrl: app.provisioningCallbackUrl, deletesDataOnDeprovision: app.deletesDataOnDeprovision } }),
    permissions: app.permissions.map((p) => ({ name: p.name, description: p.description ?? p.name })),
    menu: app.menuItems.map((i) => ({ label: i.label, path: i.path, ...(i.icon && { icon: i.icon }), ...(i.permission && { permission: i.permission }) })),
  };
}
