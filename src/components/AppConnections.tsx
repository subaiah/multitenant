/**
 * Which of the organization's applications can call which (Application
 * Entitlements): what each may do in the other and why, whether on behalf of
 * people, how much it's used, and Block / Allow for administrators.
 * backend/src/lib/app-connections.ts; docs/adr/0001-app-to-app-calls.md.
 */
import { useState } from 'react';
import { ArrowRight, Ban, CheckCircle2, UserRound } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { apiPut } from '../lib/api-client';
import { invalidateApi } from '../lib/query';
import { formatRelative } from './ui';

interface Connection {
  caller: { id: string; key: string; name: string };
  target: { id: string; key: string; name: string };
  scopes: { name: string; description: string; reason: string; allowsOnBehalfOf: boolean }[];
  blocked: boolean;
  blockedAt: string | null;
  blockedByEmail: string | null;
  tokensIssued: number;
  lastIssuedAt: string | null;
}

export default function AppConnections({ canManage }: { canManage: boolean }) {
  const path = '/tenant-applications/connections';
  const info = useApi<{ connections: Connection[] }>(path);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connections = info.data?.connections ?? [];
  if (!connections.length) return null;

  const set = async (c: Connection, blocked: boolean) => {
    if (blocked && !confirm(`Block ${c.caller.name} from calling ${c.target.name}? Features that depend on it stop working at once.`)) return;
    setBusy(`${c.caller.id}-${c.target.id}`);
    setError(null);
    try {
      await apiPut(path, { callerApplicationId: c.caller.id, targetApplicationId: c.target.id, blocked });
      await invalidateApi(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Saving failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mt-6 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700" aria-labelledby="connections-title">
      <div className="p-4 border-b border-slate-200 dark:border-slate-700">
        <h2 id="connections-title" className="text-lg font-semibold text-slate-900 dark:text-white">Connections between applications</h2>
        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
          What your applications can do in each other. Allowed while you have both on; block a connection to stop it at once.
        </p>
      </div>
      {error && <p role="alert" className="px-4 pt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      <ul className="divide-y divide-slate-200 dark:divide-slate-700">
        {connections.map((c) => {
          const id = `${c.caller.id}-${c.target.id}`;
          return (
            <li key={id} className="p-4 flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-medium text-slate-900 dark:text-white">
                  {c.caller.name} <ArrowRight size={16} className="text-slate-400" aria-label="can call" /> {c.target.name}
                  {c.blocked
                    ? <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700 dark:text-red-400"><Ban size={13} aria-hidden /> Blocked</span>
                    : <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400"><CheckCircle2 size={13} aria-hidden /> Allowed</span>}
                </p>
                <ul className="mt-2 space-y-1.5 text-sm">
                  {c.scopes.map((s) => (
                    <li key={s.name} className="text-slate-700 dark:text-slate-200">
                      {s.description}
                      {s.allowsOnBehalfOf && (
                        <span className="ml-2 inline-flex items-center gap-1 text-xs text-slate-500" title="Acting for the person using it, with that person's access">
                          <UserRound size={12} aria-hidden /> as the person using it
                        </span>
                      )}
                      <span className="block text-xs text-slate-500">Why: {s.reason}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-slate-500">
                  {c.blocked && c.blockedAt
                    ? `Blocked ${formatRelative(c.blockedAt)}${c.blockedByEmail ? ` by ${c.blockedByEmail}` : ''}`
                    : c.tokensIssued ? `Used ${c.tokensIssued} time${c.tokensIssued === 1 ? '' : 's'}, last ${formatRelative(c.lastIssuedAt!)}` : 'Not used yet'}
                </p>
              </div>
              {canManage && (
                <button type="button" disabled={busy === id} onClick={() => void set(c, !c.blocked)}
                  className={c.blocked
                    ? 'px-3 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700'
                    : 'px-3 py-1.5 text-sm rounded-lg border border-red-200 dark:border-red-500/40 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10'}>
                  {c.blocked ? 'Allow' : 'Block'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
