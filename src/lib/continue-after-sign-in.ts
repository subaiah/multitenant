/**
 * Signing in to an application with your organization account ("Sign in
 * with", backend lib/oidc/): the provider sends people who aren't signed in
 * here with `?continue=<its sign-in step>`, and once they are, they go back
 * there to finish signing in to the application.
 *
 * Only the provider's own sign-in step is accepted, so the parameter can't be
 * used to send people to another site. It's kept for the tab's session, so
 * it survives single sign-on's trip to the identity provider and back.
 */
import { API_URL } from './api-client';
import { portalHome, type Portal } from './permissions';

const KEY = 'continue-after-sign-in';

function interactionUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const api = new URL(API_URL, window.location.origin);
    const target = new URL(value, window.location.origin);
    const base = api.pathname.replace(/\/+$/, '');
    const step = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/oidc/interaction/[A-Za-z0-9_-]+$`);
    return target.origin === api.origin && step.test(target.pathname) && !target.search && !target.hash ? target.href : null;
  } catch {
    return null;
  }
}

/** Keep a `continue` from this page's address, if it's one we accept */
export function rememberContinue(search: string): void {
  const target = interactionUrl(new URLSearchParams(search).get('continue'));
  if (!target) return;
  try {
    sessionStorage.setItem(KEY, target);
  } catch {
    // storage unavailable: the address still has it
  }
}

/** Whether signing in here finishes signing in to an application */
export function continuing(search: string): boolean {
  if (interactionUrl(new URLSearchParams(search).get('continue'))) return true;
  try {
    return !!interactionUrl(sessionStorage.getItem(KEY));
  } catch {
    return false;
  }
}

function takeContinue(): string | null {
  try {
    const value = interactionUrl(sessionStorage.getItem(KEY));
    sessionStorage.removeItem(KEY);
    return value;
  } catch {
    return null;
  }
}

/**
 * Where to go once signed in: back to the application's sign-in (which tells
 * platform staff they can't use it), otherwise the portal's home page
 */
export function goAfterSignIn(navigate: (to: string, opts?: { replace?: boolean }) => void, portal: Portal): void {
  const target = takeContinue();
  if (target) {
    window.location.assign(target);
    return;
  }
  navigate(portalHome(portal), { replace: true });
}
