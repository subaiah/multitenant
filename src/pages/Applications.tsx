/**
 * The organization's applications: those it has turned on, to open them.
 * Each opens at its own sign-in start, and people sign in with their account
 * here (backend lib/oidc/; docs/SIGN_IN_WITH.md).
 */
import { Link } from 'react-router-dom';
import { ExternalLink, Package } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';
import { Badge, Card, DataView, EmptyState, PageHeader, formatDate, primaryButtonClass, secondaryButtonClass } from '../components/ui';

interface LaunchpadApp {
  id: string;
  key: string;
  name: string;
  description: string | null;
  state: 'ENABLED' | 'TRIAL';
  validTo: string | null;
  signIn: boolean;
  openUrl: string | null;
}

export default function Applications() {
  const list = useApi<{ applications: LaunchpadApp[] }>('/tenant-applications/launchpad');
  const canManage = useAuth().hasPermission('applications:manage');
  const manage = canManage && <Link to="/tenant-entitlements" className={secondaryButtonClass}>Choose applications</Link>;

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Applications" description="The applications your organization uses. Sign in to them with your account here." actions={manage || undefined} />
      <DataView {...list}>
        {({ applications }) =>
          applications.length === 0 ? (
            <Card>
              <EmptyState
                icon={Package}
                title="No applications yet"
                message={canManage ? 'Turn on the applications your organization uses, and they appear here for everyone.' : 'When an administrator turns on applications for your organization, they appear here.'}
                action={manage || undefined}
              />
            </Card>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {applications.map((a) => (
                <li key={a.id} className="flex flex-col gap-3 min-w-0 bg-white dark:bg-slate-800 rounded-lg p-5 border border-slate-200 dark:border-slate-700">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div aria-hidden className="w-10 h-10 shrink-0 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center text-slate-600 dark:text-slate-200 font-semibold">
                        {a.name.charAt(0).toUpperCase()}
                      </div>
                      <h2 className="font-semibold text-slate-800 dark:text-white truncate">{a.name}</h2>
                    </div>
                    {a.state === 'TRIAL' && <Badge value="TRIAL" />}
                  </div>
                  {a.description && <p className="text-sm text-slate-600 dark:text-slate-300">{a.description}</p>}
                  {a.validTo && <p className="text-xs text-slate-500">Available until {formatDate(a.validTo)}</p>}
                  <div className="mt-auto pt-1">
                    {a.openUrl ? (
                      <a href={a.openUrl} target="_blank" rel="noopener" className={primaryButtonClass}>
                        Open <ExternalLink size={14} aria-hidden />
                      </a>
                    ) : (
                      <p className="text-xs text-slate-500">{a.signIn ? 'Open it from its own address; sign in with your account here.' : "This application doesn't use your account here to sign in."}</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </DataView>
    </div>
  );
}
