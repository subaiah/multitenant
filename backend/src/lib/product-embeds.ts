/**
 * Applications inside each other's pages (docs/hub/HUB_GAPS.md G5).
 *
 * - Embeds: an application's manifest offers Web Components (e.g.
 *   <hearth-record-thread>). Another application finds the ones it may use for
 *   an organization here, and loads them in its own pages. Nothing is framed:
 *   the platform's pages keep frame-ancestors 'none'.
 * - An embedded component never signs anyone in itself. The host page gets a
 *   token for it from the host application's server, which exchanges the
 *   person's token for one to the embedding application (RFC 8693, G1:
 *   lib/oidc/token-exchange.ts). So a component is usable where that
 *   connection is: both on, a consumed scope that allows acting on behalf of
 *   a person, not blocked. `usable` says so, and why not.
 * - Branding: the organization's name, logo and colour, and theme tokens
 *   (CSS custom properties) every application can apply, so they look like
 *   one product.
 * - The launcher: which of the organization's applications a person can open
 *   (as the tenant portal's menu shows them), for <mt-app-launcher> in every
 *   application's header (embed/launcher.ts).
 */
import { controlDb } from './prisma.js';
import { audienceOf, checkConnection, ConnectionRefused } from './app-connections.js';
import { readableOrganization } from './product-data.js';
import { grantedForMenus, productsWithEntries } from './product-menu.js';
import { accountIdFor, parseAccountId } from './oidc/accounts.js';
import { appOriginForTenant } from './domains.js';
import { AppError } from '../middleware/error-handler.js';

/** The Web Components other applications the organization has on offer, and whether the caller can use each now */
export async function embedsFor(callerApplicationId: string, tenantId: string) {
  await readableOrganization(callerApplicationId, tenantId);
  const now = new Date();
  const rows = await controlDb.productEmbed.findMany({
    where: {
      applicationId: { not: callerApplicationId },
      application: {
        status: 'ACTIVE',
        tenantApplications: { some: { tenantId, state: { in: ['ENABLED', 'TRIAL'] }, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] } },
      },
    },
    include: { application: { select: { id: true, key: true, name: true } } },
    orderBy: [{ application: { name: 'asc' } }, { position: 'asc' }],
  });
  // One check per application, not per component
  const usable = new Map<string, { usable: boolean; reason: string | null }>();
  for (const key of new Set(rows.map((r) => r.application.key))) {
    try {
      await checkConnection({ callerApplicationId, targetResource: audienceOf(key), tenantId, onBehalfOf: true });
      usable.set(key, { usable: true, reason: null });
    } catch (err) {
      if (!(err instanceof ConnectionRefused)) throw err;
      usable.set(key, { usable: false, reason: err.message });
    }
  }
  return {
    embeds: rows.map((r) => ({
      productId: r.application.key,
      application: r.application.name,
      tag: r.tag,
      scriptUrl: r.scriptUrl,
      attributes: r.attributes,
      description: r.description,
      /** The `resource` to exchange the person's token for */
      audience: audienceOf(r.application.key),
      ...usable.get(r.application.key)!,
    })),
  };
}

/** Black or white text on a colour, whichever reads better (WCAG relative luminance) */
export function contrastOn(hex: string): '#000000' | '#ffffff' {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? '#000000' : '#ffffff';
}

const DEFAULT_PRIMARY = '#3b82f6';

/** The organization's branding, and theme tokens derived from it */
export async function brandingOf(applicationId: string, tenantId: string) {
  await readableOrganization(applicationId, tenantId);
  const t = await controlDb.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { id: true, slug: true, name: true, logoUrl: true, primaryColor: true } });
  const primary = t.primaryColor && /^#[0-9a-fA-F]{6}$/.test(t.primaryColor) ? t.primaryColor.toLowerCase() : DEFAULT_PRIMARY;
  return {
    organization: { id: t.id, slug: t.slug, name: t.name },
    logoUrl: t.logoUrl,
    primaryColor: primary,
    /** CSS custom properties: set them on :root (or a host element); the launcher and embedded components read them */
    theme: {
      '--mt-color-primary': primary,
      '--mt-color-on-primary': contrastOn(primary),
      '--mt-radius': '8px',
      '--mt-font-family': 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
    },
    portalUrl: `${await appOriginForTenant(t.id)}/${t.slug}/login`,
  };
}

/**
 * The organization's applications a person can open, with the pages in each
 * (as the tenant portal's menu shows them), for the launcher. `current`: the
 * caller.
 */
export async function launcherFor(callerApplicationId: string, tenantId: string, subject: string) {
  const db = await readableOrganization(callerApplicationId, tenantId);
  const ids = parseAccountId(subject);
  const user = ids && ids.tenantId === tenantId
    ? await db.user.findFirst({ where: { id: ids.userId, tenantId, status: 'ACTIVE' }, select: { id: true, userType: true } })
    : null;
  if (!user) throw new AppError('No active person with that subject in this organization', 404, true, 'NOT_FOUND');
  const products = await productsWithEntries(tenantId, await grantedForMenus(user.id, tenantId, user.userType));
  const t = await controlDb.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { slug: true, name: true } });
  return {
    subject: accountIdFor(tenantId, user.id),
    organization: { id: tenantId, slug: t.slug, name: t.name },
    portal: { label: t.name, url: `${await appOriginForTenant(tenantId)}/${t.slug}/login` },
    applications: products.map(({ app, entries }) => ({
      productId: app.key,
      name: app.name,
      current: app.id === callerApplicationId,
      url: `${app.baseUrl}${entries[0].path}`,
      entries: entries.map((e) => ({ label: e.label, url: `${app.baseUrl}${e.path}`, icon: e.icon })),
    })),
  };
}
