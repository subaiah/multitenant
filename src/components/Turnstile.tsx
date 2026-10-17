/**
 * Cloudflare Turnstile, the sign-up form's bot check (TURNSTILE_SITE_KEY on
 * the server). Loads Cloudflare's script on first use; calls onToken with the
 * answer to send, or null when it expires.
 */
import { useEffect, useRef } from 'react';

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id: string) => void;
  remove: (id: string) => void;
}
declare global {
  interface Window { turnstile?: TurnstileApi }
}

let loading: Promise<TurnstileApi> | null = null;
function loadTurnstile(): Promise<TurnstileApi> {
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not load')));
    s.onerror = () => { loading = null; reject(new Error('Turnstile did not load')); };
    document.head.appendChild(s);
  });
  return loading;
}

/** `resetKey`: change it to get a fresh check (an answer can be used once) */
export function Turnstile({ siteKey, onToken, resetKey }: { siteKey: string; onToken: (token: string | null) => void; resetKey: number }) {
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<{ api: TurnstileApi; id: string } | null>(null);
  const callback = useRef(onToken);
  callback.current = onToken;

  useEffect(() => {
    let cancelled = false;
    loadTurnstile()
      .then((api) => {
        if (cancelled || !box.current) return;
        const dark = document.documentElement.classList.contains('dark');
        const id = api.render(box.current, {
          sitekey: siteKey,
          theme: dark ? 'dark' : 'light',
          callback: (t: string) => callback.current(t),
          'expired-callback': () => callback.current(null),
          'error-callback': () => callback.current(null),
        });
        widget.current = { api, id };
      })
      .catch(() => callback.current(null));
    return () => {
      cancelled = true;
      if (widget.current) widget.current.api.remove(widget.current.id);
      widget.current = null;
    };
  }, [siteKey]);

  useEffect(() => {
    if (resetKey && widget.current) {
      widget.current.api.reset(widget.current.id);
      callback.current(null);
    }
  }, [resetKey]);

  return <div ref={box} className="min-h-[65px]" />;
}
