import { ShieldCheck } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';
import { apiPost } from '../lib/api-client';
import { TwoFactorSettings } from '../components/TwoFactorSettings';
import { Badge, Card, DataView, EmptyState, PageHeader, formatDate, formatRelative, humanize } from '../components/ui';

interface PlatformUser {
  id: string;
  email: string;
  name: string | null;
  userType: string;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
  mfaEnabled: boolean;
}

export default function PlatformUsers() {
  const { user, hasPermission } = useAuth();
  const users = useApi<{ users: PlatformUser[] }>('/platform/users');
  const canReset = hasPermission('platform-settings:manage');

  const resetTwoFactor = async (u: PlatformUser) => {
    if (!window.confirm(`Reset two-factor for ${u.email}? They will set it up again the next time they sign in.`)) return;
    try {
      await apiPost(`/platform/users/${u.id}/mfa/reset`);
      await users.reload();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Could not reset two-factor');
    }
  };

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Platform Users" description="People who operate the platform across all tenants" />
      <Card title="Your two-factor sign-in">
        <TwoFactorSettings />
      </Card>
      <DataView {...users}>
        {({ users: list }) =>
          list.length === 0 ? (
            <Card><EmptyState icon={ShieldCheck} title="No platform users" /></Card>
          ) : (
            <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-900/50 text-left text-xs uppercase text-slate-500 dark:text-slate-400">
                  <tr>
                    <th className="px-5 py-3 font-medium">User</th>
                    <th className="px-5 py-3 font-medium">Role</th>
                    <th className="px-5 py-3 font-medium">Status</th>
                    <th className="px-5 py-3 font-medium">Two-factor</th>
                    <th className="px-5 py-3 font-medium">Last sign-in</th>
                    <th className="px-5 py-3 font-medium">Added</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                  {list.map((u) => (
                    <tr key={u.id}>
                      <td className="px-5 py-3">
                        <p className="font-medium text-slate-800 dark:text-white">
                          {u.name || u.email} {u.id === user?.id && <span className="text-xs font-normal text-slate-400">(you)</span>}
                        </p>
                        <p className="text-xs text-slate-500">{u.email}</p>
                      </td>
                      <td className="px-5 py-3 text-slate-600 dark:text-slate-300">{humanize(u.userType.replace('PLATFORM_', ''))}</td>
                      <td className="px-5 py-3"><Badge value={u.status} /></td>
                      <td className="px-5 py-3">
                        <span className={u.mfaEnabled ? 'text-green-600 dark:text-green-400' : 'text-slate-400'}>{u.mfaEnabled ? 'On' : 'Off'}</span>
                        {canReset && u.mfaEnabled && u.id !== user?.id && (
                          <button type="button" onClick={() => void resetTwoFactor(u)} className="ml-3 text-xs font-medium text-blue-600 hover:text-blue-700">
                            Reset
                          </button>
                        )}
                      </td>
                      <td className="px-5 py-3 text-slate-500">{formatRelative(u.lastLoginAt)}</td>
                      <td className="px-5 py-3 text-slate-500">{formatDate(u.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </DataView>
    </div>
  );
}
