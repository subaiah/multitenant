import { beforeEach, describe, expect, it, vi } from 'vitest';
import { goAfterSignIn, rememberConnect } from './continue-after-sign-in';

beforeEach(() => sessionStorage.clear());

describe('coming back to a Connect request after signing in', () => {
  it('returns platform staff to the request, once', () => {
    const navigate = vi.fn();
    rememberConnect('/platform/applications/connect?app_url=https%3A%2F%2Fhearth.example.com&state=s');
    goAfterSignIn(navigate, 'PLATFORM');
    expect(navigate).toHaveBeenCalledWith('/platform/applications/connect?app_url=https%3A%2F%2Fhearth.example.com&state=s', { replace: true });
    goAfterSignIn(navigate, 'PLATFORM');
    expect(navigate).toHaveBeenLastCalledWith('/platform/dashboard', { replace: true });
  });

  it('accepts only the Connect page on this site', () => {
    const navigate = vi.fn();
    rememberConnect('https://evil.example.com/platform/applications/connect?x=1');
    goAfterSignIn(navigate, 'PLATFORM');
    rememberConnect('/platform/tenants');
    goAfterSignIn(navigate, 'PLATFORM');
    expect(navigate.mock.calls.map((c) => c[0])).toEqual(['/platform/dashboard', '/platform/dashboard']);
  });

  it('does not send a tenant user there', () => {
    const navigate = vi.fn();
    rememberConnect('/platform/applications/connect?x=1');
    goAfterSignIn(navigate, 'TENANT');
    expect(navigate).toHaveBeenCalledWith('/dashboard', { replace: true });
  });
});
