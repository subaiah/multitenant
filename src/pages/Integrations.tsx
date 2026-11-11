/**
 * Every external product's integration at a glance (platform staff): what's
 * set up, how its organizations' setup stands, and whether events, user
 * events and logout tokens are getting through. Each links to its panels on
 * the Applications page. backend/src/routes/application-integrations.ts.
 */
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Clock, LogOut, Plug } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { Badge, DataView, EmptyState, PageHeader, StatCard, formatDateTime, formatRelative } from '../components/ui';
import IntegrationGuide from '../components/IntegrationGuide';

interface Integration {
  id: string;
  key: string;
  name: string;
  status: string;
  version: string;
  manifestImportedAt: string | null;
  signIn: { enabled: boolean; clientType: string; backchannelLogout: boolean; accessTokenLifetime: number } | null;
  lifecycle: { callback: boolean; userEvents: boolean };
  credentials: { active: number; lastUsedAt: string | null };
  appToApp: { exposes: number; consumes: number; tokensIssued: number; lastIssuedAt: string | null; blockedBy: number };
  organizations: { total: number; ready: number; settingUp: number; failed: number };
  events: { pending: number; failed: number; lastDeliveredAt: string | null; pendingSince: string | null };
  logouts: { pending: number; failed: number; lastDeliveredAt: string | null };
  attention: string[];
  health: { status: 'UP' | 'DEGRADED' | 'DOWN' | null; version: string | null; responseMs: number | null; checkedAt: string | null; since: string | null; error: string | null } | null;
}

export default function Integrations() {
  const info = useApi<{ applications: Integration[] }>('/applications/integrations');
  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Integrations" description="Every external product: how it's connected, how its organizations' setup stands, and whether events and logouts are getting through." />
      <DataView {...info}>
        {({ applications }) => {
          if (!applications.length) {
            return (
              <>
                <IntegrationGuide applications={applications} />
                <EmptyState icon={Plug} title="No external products yet" message="Import a product's manifest on the Applications page." />
              </>
            );
          }
          const needs = applications.filter((a) => a.attention.length);
          const waiting = applications.reduce((n, a) => n + a.events.pending, 0);
          const logouts = applications.reduce((n, a) => n + a.logouts.pending, 0);
          return (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard label="Products" value={applications.length} icon={Plug} />
                <StatCard label="Need attention" value={needs.length} icon={AlertTriangle} tone={needs.length ? 'amber' : 'green'} />
                <StatCard label="Events waiting" value={waiting} icon={Clock} />
                <StatCard label="Logouts waiting" value={logouts} icon={LogOut} />
              </div>
              <IntegrationGuide applications={applications} />
              <ul className="space-y-4">
                {[...needs, ...applications.filter((a) => !a.attention.length)].map((a) => <IntegrationCard key={a.id} a={a} />)}
              </ul>
            </>
          );
        }}
      </DataView>
    </div>
  );
}

const yes = (on: boolean, label = on ? 'On' : 'Off') => (
  <span className={on ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400'}>{label}</span>
);

function IntegrationCard({ a }: { a: Integration }) {
  const o = a.organizations;
  return (
    <li className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold text-slate-800 dark:text-white">
            {a.name} <Badge value={a.status} className="ml-1 align-middle" />
          </h2>
          <p className="text-xs text-slate-500 font-mono break-all">{a.key} · v{a.version}{a.manifestImportedAt && ` · manifest ${formatRelative(a.manifestImportedAt)}`}</p>
        </div>
        <Link to={`/platform/applications?id=${a.id}`} className="text-sm text-blue-600 hover:text-blue-700 dark:text-blue-400">Open settings</Link>
      </div>

      {a.attention.length > 0 ? (
        <ul className="mt-3 space-y-1 rounded-md border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-3">
          {a.attention.map((t) => (
            <li key={t} className="flex items-start gap-2 text-sm text-amber-900 dark:text-amber-200"><AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden />{t}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400"><CheckCircle2 size={15} aria-hidden /> Nothing needs attention</p>
      )}

      <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <Item label="Health">
          {!a.health ? 'No health address in its manifest' : !a.health.checkedAt ? 'Not checked yet' : (
            <>
              <span className={a.health.status === 'UP' ? 'text-emerald-700 dark:text-emerald-400' : a.health.status ? 'text-amber-700 dark:text-amber-400' : ''}>
                {a.health.status === 'UP' ? 'Up' : a.health.status === 'DEGRADED' ? 'Degraded' : a.health.status === 'DOWN' ? 'Down' : 'Unknown'}
              </span>
              {a.health.version && ` · v${a.health.version}`}{a.health.responseMs !== null && ` · ${a.health.responseMs} ms`}
              <span className="block text-xs text-slate-500">
                Checked {formatRelative(a.health.checkedAt)}{a.health.since ? ` · since ${formatRelative(a.health.since)}` : ''}{a.health.error ? ` · ${a.health.error}` : ''}
              </span>
            </>
          )}
        </Item>
        <Item label="Sign-in">
          {a.signIn ? (
            <>
              {yes(a.signIn.enabled)} · tokens {Math.round(a.signIn.accessTokenLifetime / 60)} min · back-channel logout {yes(a.signIn.backchannelLogout)}
            </>
          ) : 'Not set up'}
        </Item>
        <Item label="Lifecycle events">
          {a.lifecycle.callback ? <>Callback {yes(true, 'set')} · user events {yes(a.lifecycle.userEvents)}</> : 'No callback'}
        </Item>
        <Item label="Service credentials">
          {a.credentials.active ? `${a.credentials.active} active · ${a.credentials.lastUsedAt ? `used ${formatRelative(a.credentials.lastUsedAt)}` : 'not used yet'}` : 'None'}
        </Item>
        <Item label="Calls between applications">
          {a.appToApp.exposes || a.appToApp.consumes
            ? <>{`Exposes ${a.appToApp.exposes} scope${a.appToApp.exposes === 1 ? '' : 's'} · consumes ${a.appToApp.consumes}`}
                <span className="block text-xs text-slate-500">
                  {a.appToApp.tokensIssued ? `${a.appToApp.tokensIssued} tokens issued, last ${formatRelative(a.appToApp.lastIssuedAt!)}` : 'No tokens issued yet'}
                  {a.appToApp.blockedBy ? ` · blocked by ${a.appToApp.blockedBy} organization${a.appToApp.blockedBy === 1 ? '' : 's'}` : ''}
                </span></>
            : 'None'}
        </Item>
        <Item label="Organizations">
          {o.total ? `${o.ready} of ${o.total} ready${o.settingUp ? ` · ${o.settingUp} setting up` : ''}${o.failed ? ` · ${o.failed} failed` : ''}` : 'None have it on'}
        </Item>
        <Item label="Events">
          {`${a.events.pending} waiting · ${a.events.failed} given up`}
          {a.events.lastDeliveredAt && <span className="block text-xs text-slate-500" title={formatDateTime(a.events.lastDeliveredAt)}>last delivered {formatRelative(a.events.lastDeliveredAt)}</span>}
        </Item>
        <Item label="Logout tokens">
          {`${a.logouts.pending} waiting · ${a.logouts.failed} given up`}
          {a.logouts.lastDeliveredAt && <span className="block text-xs text-slate-500" title={formatDateTime(a.logouts.lastDeliveredAt)}>last delivered {formatRelative(a.logouts.lastDeliveredAt)}</span>}
        </Item>
      </dl>
    </li>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="text-slate-700 dark:text-slate-200">{children}</dd>
    </div>
  );
}
