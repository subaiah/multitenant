import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { permissionMatches } from '../lib/permissions';
import { PermissionButton, PermissionGuard, PermissionLink } from './PermissionGuard';

/** What the signed-in user holds, for the test at hand */
const session = { permissions: [] as string[], scoped: [] as string[], loading: false };

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    permissions: session.permissions,
    loading: session.loading,
    hasPermission: (p: string) => permissionMatches(session.permissions, p),
    // Held somewhere: for the whole tenant, or for one organization or unit
    hasPermissionAnywhere: (p: string) => permissionMatches([...session.permissions, ...session.scoped], p),
    reload: async () => {},
  }),
}));

function signedInWith(permissions: string[], scoped: string[] = []) {
  session.permissions = permissions;
  session.scoped = scoped;
  session.loading = false;
}

afterEach(cleanup);

describe('PermissionGuard', () => {
  it('shows its content to someone who holds the permission, and nothing to someone who does not', () => {
    signedInWith(['users:read']);
    render(<PermissionGuard permission="users:read">the users</PermissionGuard>);
    expect(screen.queryByText('the users')).not.toBeNull();
    cleanup();

    signedInWith(['groups:read']);
    const { container } = render(<PermissionGuard permission="users:read">the users</PermissionGuard>);
    expect(container.textContent).toBe('');
  });

  it('honours wildcards', () => {
    signedInWith(['users:*']);
    render(<PermissionGuard permission="users:delete">delete</PermissionGuard>);
    expect(screen.queryByText('delete')).not.toBeNull();
  });

  it('anyOf needs one of them, allOf needs every one', () => {
    signedInWith(['users:read']);
    render(<PermissionGuard anyOf={['users:read', 'users:create']}>any</PermissionGuard>);
    render(<PermissionGuard allOf={['users:read', 'users:create']}>all</PermissionGuard>);
    expect(screen.queryByText('any')).not.toBeNull();
    expect(screen.queryByText('all')).toBeNull();
  });

  it('shows the fallback instead when one is given', () => {
    signedInWith([]);
    render(<PermissionGuard permission="audit:read" fallback={<p>not for you</p>}>the log</PermissionGuard>);
    expect(screen.queryByText('the log')).toBeNull();
    expect(screen.queryByText('not for you')).not.toBeNull();
  });

  it('sends the person elsewhere when asked to', () => {
    signedInWith([]);
    render(
      <MemoryRouter initialEntries={['/audit-log']}>
        <Routes>
          <Route path="/audit-log" element={<PermissionGuard permission="audit:read" redirectTo="/dashboard">the log</PermissionGuard>} />
          <Route path="/dashboard" element={<p>the dashboard</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByText('the log')).toBeNull();
    expect(screen.queryByText('the dashboard')).not.toBeNull();
  });

  it('with "anywhere", a role for one organization or unit is enough', () => {
    signedInWith([], ['organizations:read']);
    render(<PermissionGuard permission="organizations:read">tenant-wide only</PermissionGuard>);
    render(<PermissionGuard permission="organizations:read" anywhere>held somewhere</PermissionGuard>);
    expect(screen.queryByText('tenant-wide only')).toBeNull();
    expect(screen.queryByText('held somewhere')).not.toBeNull();
  });

  it('shows neither the content nor the fallback while permissions are loading', () => {
    signedInWith(['users:read']);
    session.loading = true;
    render(<PermissionGuard permission="users:read" fallback={<p>not for you</p>}>the users</PermissionGuard>);
    expect(screen.queryByText('the users')).toBeNull();
    expect(screen.queryByText('not for you')).toBeNull();
  });

  it('with nothing asked for, shows its content', () => {
    signedInWith([]);
    render(<PermissionGuard>everyone</PermissionGuard>);
    expect(screen.queryByText('everyone')).not.toBeNull();
  });
});

describe('PermissionButton and PermissionLink', () => {
  it('are there only for someone who may use them', () => {
    signedInWith(['users:delete']);
    render(<PermissionButton permission="users:delete">Delete user</PermissionButton>);
    render(<PermissionLink permission="users:update" href="/users/1/edit">Edit user</PermissionLink>);
    expect(screen.queryByRole('button', { name: 'Delete user' })).not.toBeNull();
    expect(screen.queryByRole('link', { name: 'Edit user' })).toBeNull();
  });
});
