/**
 * Applications inside each other's pages (docs/PRODUCT_INTEGRATION.md,
 * "Embedding another application").
 *
 * - themeCss(): the organization's theme tokens (GET …/branding) as CSS, for
 *   your own pages, the launcher and embedded components alike.
 * - An embedded component gets its token from your server: exchange the
 *   person's token for one to the embedding application
 *   (createAppTokens().onBehalfOf(personToken, productId)) and hand it to the
 *   component as it asks. Never run a sign-in inside a component or a frame.
 */

/** The theme tokens as a CSS rule (custom properties only; values are checked so they can't close the rule) */
export function themeCss(theme: Record<string, string>, selector = ':root'): string {
  const safe = Object.entries(theme).filter(([k, v]) => /^--mt-[a-z0-9-]+$/.test(k) && !/[;{}<>]/.test(v));
  return `${selector}{${safe.map(([k, v]) => `${k}:${v}`).join(';')}}`;
}

/** The launcher script on the platform, for a <script type="module"> tag (apiBaseUrl: e.g. https://app.example.com/api) */
export const launcherScriptUrl = (apiBaseUrl: string) => `${apiBaseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/embed/v1/launcher.js`;
