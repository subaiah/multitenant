/**
 * Errors in this browser go to the API (POST /bff/errors), which passes them
 * to error tracking when it's set up (backend/src/lib/error-reporting.ts) and
 * drops them otherwise. Sent: the error's message and stack, and the page's
 * path. Never the query string or what's on the page.
 *
 * A few per page load at most, and the same error only once.
 */
import { API_URL } from './api-client';

const MAX_PER_PAGE = 10;
let sent = 0;
const seen = new Set<string>();

// Errors that don't come from this app: browser extensions, scripts the
// browser injected, and a network that dropped (shown to the person already)
const IGNORED = [/ResizeObserver loop/, /^Script error\.?$/, /chrome-extension:|moz-extension:|safari-extension:/, /Failed to fetch|NetworkError|Load failed/];

export function reportClientError(error: unknown) {
  const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Unknown error');
  const message = (err.message || String(error)).slice(0, 1000);
  const text = `${message}\n${err.stack ?? ''}`;
  if (!message || IGNORED.some((re) => re.test(text))) return;
  const key = `${err.name}:${message}:${(err.stack ?? '').split('\n')[1] ?? ''}`;
  if (seen.has(key) || sent >= MAX_PER_PAGE) return;
  seen.add(key);
  sent++;
  const body = JSON.stringify({
    message,
    type: err.name?.slice(0, 100) || 'Error',
    ...(err.stack && { stack: err.stack.slice(0, 8000) }),
    path: window.location.pathname.slice(0, 300),
  });
  // keepalive: still delivered if the page is being left
  fetch(`${API_URL}/bff/errors`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true, credentials: 'omit' }).catch(() => {});
}

export function installErrorReporting() {
  window.addEventListener('error', (e) => reportClientError(e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => reportClientError(e.reason));
}
