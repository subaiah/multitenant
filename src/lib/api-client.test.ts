import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  API_URL, ApiError, AuthError, SESSION_ENDED_EVENT, apiGet, apiPost, setActingTenant,
  type SessionEndReason,
} from './api-client';

/** One answer from the server */
const answer = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });

type Call = { url: string; init: RequestInit };
let calls: Call[];
/** Answers handed out in order, one per request */
let queue: (Response | (() => Response))[];

const paths = () => calls.map((c) => c.url.replace(API_URL, ''));
const headerOf = (call: Call, name: string) => new Headers(call.init.headers).get(name);

beforeEach(() => {
  calls = [];
  queue = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const next = queue.shift();
      if (!next) throw new Error(`No answer queued for ${url}`);
      return typeof next === 'function' ? next() : next;
    }),
  );
  localStorage.clear();
  setActingTenant(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a request', () => {
  it('sends cookies and returns the JSON', async () => {
    queue.push(answer(200, { id: 1 }));
    expect(await apiGet('/users')).toEqual({ id: 1 });
    expect(paths()).toEqual(['/users']);
    expect(calls[0].init.credentials).toBe('include');
    expect(calls[0].init.method).toBe('GET');
  });

  it('sends a body as JSON, and nothing for no body', async () => {
    queue.push(answer(200, {}), answer(200, {}));
    await apiPost('/groups', { name: 'Finance' });
    await apiPost('/bff/auth/logout');
    expect(calls[0].init.body).toBe('{"name":"Finance"}');
    expect(headerOf(calls[0], 'Content-Type')).toBe('application/json');
    expect(calls[1].init.body).toBeUndefined();
    expect(headerOf(calls[1], 'Content-Type')).toBeNull();
  });

  it('treats 204 as an empty answer', async () => {
    queue.push(answer(204));
    expect(await apiGet('/anything')).toEqual({});
  });

  it('throws what the server said, with the status and the body', async () => {
    queue.push(answer(409, { message: 'Group name already exists', code: 'DUPLICATE' }));
    const err = await apiPost('/groups', { name: 'Finance' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ message: 'Group name already exists', status: 409, body: { code: 'DUPLICATE' } });
  });

  it('names the organization a support session is working in', async () => {
    queue.push(answer(200, {}), answer(200, {}));
    setActingTenant('tenant-1');
    await apiGet('/users');
    setActingTenant(null);
    await apiGet('/users');
    expect(headerOf(calls[0], 'x-tenant-id')).toBe('tenant-1');
    expect(headerOf(calls[1], 'x-tenant-id')).toBeNull();
  });
});

describe('when the session has run out (401)', () => {
  it('renews it once and repeats the request', async () => {
    queue.push(answer(401), answer(200, {}), answer(200, { ok: true }));
    expect(await apiGet('/users')).toEqual({ ok: true });
    expect(paths()).toEqual(['/users', '/bff/auth/refresh', '/users']);
    expect(calls[1].init.method).toBe('POST');
  });

  it('shares one renewal between requests made at the same time', async () => {
    queue.push(answer(401), answer(401), answer(200, {}), answer(200, { n: 1 }), answer(200, { n: 2 }));
    const both = await Promise.all([apiGet('/users'), apiGet('/groups')]);
    expect(both).toHaveLength(2);
    expect(paths().filter((p) => p === '/bff/auth/refresh')).toHaveLength(1);
  });

  it('gives up when the session cannot be renewed, and says why', async () => {
    const ended: SessionEndReason[] = [];
    const listen = (e: Event) => ended.push((e as CustomEvent<SessionEndReason>).detail);
    window.addEventListener(SESSION_ENDED_EVENT, listen);
    try {
      queue.push(answer(401), answer(401, { code: 'SESSION_IDLE' }));
      await expect(apiGet('/users')).rejects.toBeInstanceOf(AuthError);
      queue.push(answer(401), answer(401, { code: 'SESSION_MAX' }));
      await expect(apiGet('/users')).rejects.toBeInstanceOf(AuthError);
      queue.push(answer(401), answer(401, { message: 'Token reuse detected' }));
      await expect(apiGet('/users')).rejects.toBeInstanceOf(AuthError);
      expect(ended).toEqual(['idle', 'max', 'signed-out']);
    } finally {
      window.removeEventListener(SESSION_ENDED_EVENT, listen);
    }
  });

  it('gives up when the repeated request is refused too', async () => {
    queue.push(answer(401), answer(200, {}), answer(401));
    await expect(apiGet('/users')).rejects.toBeInstanceOf(AuthError);
  });

  it('carries on when another request renewed the session a moment before (409 REFRESH_SUPERSEDED)', async () => {
    vi.useFakeTimers();
    queue.push(answer(401), answer(409, { code: 'REFRESH_SUPERSEDED' }), answer(200, { ok: true }));
    const result = apiGet('/users');
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toEqual({ ok: true });
    expect(paths()).toEqual(['/users', '/bff/auth/refresh', '/users']);
  });

  it('uses the renewal another tab made while this one waited its turn', async () => {
    // The lock is granted after another tab has finished renewing
    vi.stubGlobal('navigator', {
      locks: {
        request: async (_name: string, work: () => Promise<boolean>) => {
          localStorage.setItem('session-refreshed-at', String(Date.now() + 1000));
          return work();
        },
      },
    });
    queue.push(answer(401), answer(200, { ok: true }));
    expect(await apiGet('/users')).toEqual({ ok: true });
    expect(paths()).toEqual(['/users', '/users']);
  });

  it('notes a renewal for the other tabs', async () => {
    queue.push(answer(401), answer(200, {}), answer(200, {}));
    const before = Date.now();
    await apiGet('/users');
    expect(Number(localStorage.getItem('session-refreshed-at'))).toBeGreaterThanOrEqual(before);
  });

  it('leaves sign-in and background requests alone', async () => {
    queue.push(answer(401, { message: 'Invalid credentials' }));
    await expect(apiPost('/bff/auth/login', {}, { skipAuth: true })).rejects.toMatchObject({ status: 401, message: 'Invalid credentials' });
    queue.push(answer(401, { message: 'Unauthorized' }));
    await expect(apiGet('/notifications/unread', { background: true })).rejects.toBeInstanceOf(ApiError);
    expect(paths()).toEqual(['/bff/auth/login', '/notifications/unread']);
    expect(headerOf(calls[1], 'x-background-request')).toBe('1');
  });
});
