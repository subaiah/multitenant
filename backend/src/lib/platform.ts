/**
 * Slugs that address the platform portal instead of a tenant.
 * Platform users have no tenant, so they log in with one of these.
 * They are reserved: no tenant may register with them.
 */
export const PLATFORM_SLUGS = ['platform', 'admin'] as const;

/** The canonical platform slug (links and tokens use this one). */
export const PLATFORM_SLUG = 'platform';

export function isPlatformSlug(slug: string): boolean {
  return (PLATFORM_SLUGS as readonly string[]).includes(slug.toLowerCase());
}
