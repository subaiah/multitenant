import { describe, expect, it } from 'vitest';
import { canManageUserType, permissionMatches, portalHome } from './permissions';

describe('permissionMatches', () => {
  it('matches the exact permission', () => {
    expect(permissionMatches(['users:read'], 'users:read')).toBe(true);
    expect(permissionMatches(['users:read'], 'users:delete')).toBe(false);
    expect(permissionMatches([], 'users:read')).toBe(false);
  });

  it('matches wildcards the way the backend does', () => {
    expect(permissionMatches(['*'], 'users:delete')).toBe(true);
    expect(permissionMatches(['*:*'], 'users:delete')).toBe(true);
    expect(permissionMatches(['users:*'], 'users:delete')).toBe(true);
    expect(permissionMatches(['*:read'], 'users:read')).toBe(true);
    expect(permissionMatches(['users:*'], 'groups:read')).toBe(false);
    expect(permissionMatches(['*:read'], 'users:delete')).toBe(false);
  });

  it("doesn't treat a resource name as a prefix", () => {
    expect(permissionMatches(['user:*'], 'users:read')).toBe(false);
    expect(permissionMatches(['users:re'], 'users:read')).toBe(false);
  });

  it('takes a Set as well as a list, and a name without an action only exactly', () => {
    expect(permissionMatches(new Set(['roles:assign']), 'roles:assign')).toBe(true);
    expect(permissionMatches(['dashboard:*'], 'dashboard')).toBe(false);
    expect(permissionMatches(['dashboard'], 'dashboard')).toBe(true);
  });
});

describe('canManageUserType', () => {
  it('lets nobody manage a type ranked above their own', () => {
    expect(canManageUserType('TENANT_ADMIN', 'TENANT_USER')).toBe(true);
    expect(canManageUserType('TENANT_ADMIN', 'TENANT_ADMIN')).toBe(true);
    expect(canManageUserType('TENANT_MANAGER', 'TENANT_ADMIN')).toBe(false);
    expect(canManageUserType('TENANT_ADMIN', 'PLATFORM_ADMIN')).toBe(false);
  });

  it('refuses types it has never heard of, on either side', () => {
    expect(canManageUserType('SOMETHING_NEW', 'TENANT_VIEWER')).toBe(false);
    expect(canManageUserType('PLATFORM_ADMIN', 'SOMETHING_NEW')).toBe(false);
  });
});

describe('portalHome', () => {
  it('sends each portal to its own dashboard', () => {
    expect(portalHome('PLATFORM')).toBe('/platform/dashboard');
    expect(portalHome('TENANT')).toBe('/dashboard');
  });
});
