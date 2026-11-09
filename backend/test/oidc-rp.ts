/**
 * A small OpenID Connect relying party for the tests: a cookie jar that
 * follows the provider's redirects and self-submitting forms, the
 * authorization code flow with PKCE, and the token endpoint.
 * useDiscovery() once the server is up.
 */
import { createHash, randomBytes } from 'node:crypto';
import { baseUrl } from './helpers.js';

export const REDIRECT = 'http://localhost:9/callback';
let discovery: Record<string, string>;
export function useDiscovery(d: Record<string, string>) {
  discovery = d;
}

export class Browser {
  jar = new Map<string, string>();
  constructor(siteCookie = '') {
    for (const c of siteCookie.split('; ').filter(Boolean)) this.store(c);
  }
  private store(c: string) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    const name = pair.slice(0, i);
    const value = pair.slice(i + 1);
    if (!value || /expires=Thu, 01 Jan 1970/i.test(c) || /max-age=0\b/i.test(c)) this.jar.delete(name);
    else this.jar.set(name, value);
  }
  cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async go(url: string, init: RequestInit = {}) {
    const res = await fetch(url.startsWith('http') ? url : baseUrl() + url, {
      ...init,
      redirect: 'manual',
      headers: { ...(init.headers as Record<string, string>), cookie: this.cookie() },
    });
    for (const c of res.headers.getSetCookie()) this.store(c);
    return res;
  }
  /** Post a page's form, as the page's script or a click would */
  async submit(page: string, extra: Record<string, string> = {}) {
    const action = /<form[^>]*action="([^"]+)"/.exec(page)![1].replace(/&amp;/g, '&');
    const fields = Object.fromEntries([...page.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"\/?>/g)].map((m) => [m[1], m[2]]));
    return this.go(new URL(action, baseUrl()).href, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: baseUrl() },
      body: new URLSearchParams({ ...fields, ...extra }).toString(),
    });
  }
  /** Follow redirects (and self-submitting forms) on the provider until one leaves it, or a page is shown */
  async follow(url: string): Promise<{ location?: string; res: Response }> {
    let res = await this.go(url);
    for (let i = 0; i < 15; i++) {
      if (res.status >= 300 && res.status < 400) {
        const location = new URL(res.headers.get('location')!, baseUrl()).href;
        if (!location.startsWith(baseUrl())) return { location, res };
        res = await this.go(location);
      } else if (res.status === 200 && (res.headers.get('content-type') ?? '').includes('html')) {
        const page = await res.text();
        if (!/forms\[0\]\.submit\(\)|\.submit\(\)<\/script>/.test(page)) return { res: new Response(page, { status: 200 }) };
        res = await this.submit(page);
      } else break;
    }
    return { res };
  }
}

export const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

export function authorizeUrl(clientId: string, extra: Record<string, string> = {}) {
  const { verifier, challenge } = pkce();
  const state = randomBytes(8).toString('hex');
  const nonce = randomBytes(8).toString('hex');
  const u = new URL(discovery.authorization_endpoint);
  for (const [k, v] of Object.entries({
    client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', scope: 'openid email profile organization roles',
    state, nonce, code_challenge: challenge, code_challenge_method: 'S256', ...extra,
  })) u.searchParams.set(k, v);
  return { url: u.href, verifier, state, nonce };
}

export async function signIn(browser: Browser, clientId: string, extra: Record<string, string> = {}) {
  const req = authorizeUrl(clientId, extra);
  const { location, res } = await browser.follow(req.url);
  return { ...req, location: location ? new URL(location) : undefined, res };
}

export async function token(body: Record<string, string>, auth?: { id: string; secret: string }) {
  const res = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(auth && { authorization: `Basic ${Buffer.from(`${encodeURIComponent(auth.id)}:${encodeURIComponent(auth.secret)}`).toString('base64')}` }),
    },
    body: new URLSearchParams(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

