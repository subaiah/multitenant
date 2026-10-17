/**
 * Audit log: the tenant's (/audit-log) or the platform's (/platform/audit).
 * Filter, open an entry to see exactly what changed, check the log hasn't
 * been tampered with, export it, and download archived (older) entries.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Search, ShieldCheck, ShieldAlert, Download, ChevronDown, ChevronRight, Archive, Loader2, Bot, User, Building2, UserX,
} from 'lucide-react';
import { API_URL, apiGet, apiPost } from '../lib/api-client';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';
import { Card, EmptyState, ErrorState, LoadingState, PageHeader, humanize, inputClass, secondaryButtonClass, selectClass, formatDateTime } from '../components/ui';

interface Entry {
  id: string;
  seq: number;
  tenantId: string | null;
  occurredAt: string;
  event: string;
  category: string;
  outcome: 'SUCCESS' | 'FAILURE';
  actorType: 'USER' | 'PLATFORM' | 'SYSTEM' | 'ANONYMOUS';
  actorId: string | null;
  actorEmail: string | null;
  resourceType: string | null;
  resourceId: string | null;
  resourceLabel: string | null;
  changes: Record<string, [unknown, unknown]> | null;
  details: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  hash: string;
}
interface EventInfo { key: string; label: string; category: string }
interface VerifyReport {
  ok: boolean;
  entries: number;
  archives: number;
  archivedEntries: number;
  firstSeq: number | null;
  lastSeq: number | null;
  problems: { seq?: number; problem: string }[];
  verifiedAt: string;
}
interface ArchiveInfo { id: string; chain: string; fromSeq: number; toSeq: number; fromAt: string; toAt: string; rows: number; bytes: number }
interface TenantOption { id: string; name: string; slug: string }

const CATEGORIES = ['security', 'account', 'access', 'config', 'tenant', 'platform', 'audit', 'data'];
const FILTER_KEYS = ['q', 'category', 'event', 'outcome', 'from', 'to', 'tenantId'] as const;

const ACTORS = {
  USER: { icon: User, label: 'User' },
  PLATFORM: { icon: Building2, label: 'Platform staff' },
  SYSTEM: { icon: Bot, label: 'System' },
  ANONYMOUS: { icon: UserX, label: 'Not signed in' },
};

const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export default function AuditLog({ scope }: { scope: 'tenant' | 'platform' }) {
  const base = scope === 'platform' ? '/platform-audit' : '/audit';
  const { hasPermission } = useAuth();
  const canManage = scope === 'platform' ? hasPermission('platform-audit:manage') : hasPermission('audit:export');
  const canVerify = scope === 'platform' ? hasPermission('platform-audit:manage') : hasPermission('audit:read');
  const [params, setParams] = useSearchParams();
  const filterQuery = useMemo(() => {
    const q = new URLSearchParams();
    for (const k of FILTER_KEYS) {
      const v = params.get(k);
      if (v) q.set(k, k === 'from' || k === 'to' ? new Date(v + (k === 'to' ? 'T23:59:59' : 'T00:00:00')).toISOString() : v);
    }
    return q;
  }, [params]);

  const events = useApi<EventInfo[]>(`${base}/events`);
  const tenants = useApi<{ data: TenantOption[] }>(scope === 'platform' ? '/tenants?limit=100' : null);
  const labelOf = useCallback((key: string) => events.data?.find((e) => e.key === key)?.label ?? humanize(key.replace(/[._]/g, ' ')), [events.data]);
  const tenantName = (id: string | null) => (id ? tenants.data?.data.find((t) => t.id === id)?.name ?? id.slice(0, 8) : null);

  // Newest first, "Load older" appends
  const [rows, setRows] = useState<Entry[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async (before?: number) => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams(filterQuery);
      q.set('limit', '50');
      if (before) q.set('before', String(before));
      const page = await apiGet<{ data: Entry[]; nextBefore: number | null }>(`${base}?${q}`);
      setRows((prev) => (before ? [...prev, ...page.data] : page.data));
      setNextBefore(page.nextBefore);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the audit log');
    } finally {
      setLoading(false);
    }
  }, [base, filterQuery]);
  useEffect(() => {
    void load();
  }, [load]);

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key === 'category') next.delete('event');
    setParams(next, { replace: true });
  };

  // Integrity check
  const [chain, setChain] = useState('platform');
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [verifying, setVerifying] = useState(false);
  const verify = async () => {
    setVerifying(true);
    setReport(null);
    try {
      setReport(await apiGet<VerifyReport>(scope === 'platform' ? `${base}/verify?chain=${encodeURIComponent(chain)}` : `${base}/verify`));
    } catch (err) {
      setReport({ ok: false, entries: 0, archives: 0, archivedEntries: 0, firstSeq: null, lastSeq: null, problems: [{ problem: err instanceof Error ? err.message : 'Check failed' }], verifiedAt: new Date().toISOString() });
    } finally {
      setVerifying(false);
    }
  };

  const [showArchives, setShowArchives] = useState(false);
  const archives = useApi<ArchiveInfo[]>(canManage && showArchives ? `${base}/archives` : null);
  const [archiving, setArchiving] = useState<string | null>(null);
  const archiveNow = async () => {
    setArchiving('Archiving…');
    try {
      const { results } = await apiPost<{ results: { chain: string; archived: number; skipped?: string }[] }>(`${base}/archive`);
      const moved = results.reduce((n, r) => n + r.archived, 0);
      const skipped = results.filter((r) => r.skipped).length;
      setArchiving(`${moved} entr${moved === 1 ? 'y' : 'ies'} past the retention period archived${skipped ? `, ${skipped} log(s) skipped` : ''}.`);
      await archives.reload();
      void load();
    } catch (err) {
      setArchiving(err instanceof Error ? err.message : 'Archiving failed');
    }
  };

  const shownEvents = (events.data ?? []).filter((e) => !params.get('category') || e.category === params.get('category'));
  const anyFilter = FILTER_KEYS.some((k) => params.get(k));

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title={scope === 'platform' ? 'Platform Audit Log' : 'Audit Log'}
        description={scope === 'platform'
          ? 'A tamper-evident record of what platform staff and the system did'
          : 'A tamper-evident record of who changed what in your organization'}
        actions={
          <div className="flex flex-wrap gap-2">
            {canManage && (
              <a className={secondaryButtonClass} href={`${API_URL}${base}/export?${filterQuery}`} download>
                <Download size={16} />Export CSV
              </a>
            )}
          </div>
        }
      />

      {canVerify && (
        <Card>
          <div className="flex flex-wrap items-center gap-3">
            <ShieldCheck size={20} className="text-slate-400" />
            <div className="flex-1 min-w-[220px]">
              <p className="text-sm font-medium text-slate-800 dark:text-white">Integrity</p>
              <p className="text-xs text-slate-500">Each entry is signed together with the one before it, so any edit, removal or reordering shows up here.</p>
            </div>
            {scope === 'platform' && (
              <select aria-label="Which log to check" value={chain} onChange={(e) => { setChain(e.target.value); setReport(null); }} className={selectClass}>
                <option value="platform">Platform log</option>
                {(tenants.data?.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}
            <button className={secondaryButtonClass} onClick={verify} disabled={verifying}>
              {verifying ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}Check integrity
            </button>
          </div>
          {report && (
            <div role="status" className={`mt-4 p-3 rounded-lg text-sm border ${report.ok
              ? 'bg-green-50 border-green-200 text-green-800 dark:bg-green-500/10 dark:border-green-500/30 dark:text-green-300'
              : 'bg-red-50 border-red-200 text-red-800 dark:bg-red-500/10 dark:border-red-500/30 dark:text-red-300'}`}>
              <p className="flex items-center gap-2 font-medium">
                {report.ok ? <ShieldCheck size={16} /> : <ShieldAlert size={16} />}
                {report.ok ? 'Intact: no entry has been changed, removed or reordered.' : 'Problems found'}
              </p>
              <p className="mt-1 text-xs opacity-80">
                {report.entries.toLocaleString()} live entr{report.entries === 1 ? 'y' : 'ies'}
                {report.archives > 0 && ` and ${report.archivedEntries.toLocaleString()} in ${report.archives} archive file${report.archives === 1 ? '' : 's'}`} checked
                {report.lastSeq ? ` (up to #${report.lastSeq})` : ''} · {formatDateTime(report.verifiedAt)}
              </p>
              {!report.ok && (
                <ul className="mt-2 list-disc pl-5 space-y-0.5">
                  {report.problems.map((p, i) => <li key={i}>{p.seq ? `#${p.seq}: ` : ''}{p.problem}</li>)}
                </ul>
              )}
            </div>
          )}
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input aria-label="Search the audit log" placeholder="Person, record or event" defaultValue={params.get('q') ?? ''}
            onKeyDown={(e) => e.key === 'Enter' && update('q', (e.target as HTMLInputElement).value.trim())}
            onBlur={(e) => e.target.value.trim() !== (params.get('q') ?? '') && update('q', e.target.value.trim())}
            className={`${inputClass} pl-9`} />
        </div>
        <select aria-label="Category" value={params.get('category') ?? ''} onChange={(e) => update('category', e.target.value)} className={selectClass}>
          <option value="">All categories</option>
          {CATEGORIES.filter((c) => (events.data ?? []).some((e) => e.category === c)).map((c) => <option key={c} value={c}>{humanize(c)}</option>)}
        </select>
        <select aria-label="Event" value={params.get('event') ?? ''} onChange={(e) => update('event', e.target.value)} className={`${selectClass} max-w-[220px]`}>
          <option value="">All events</option>
          {shownEvents.map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}
        </select>
        <select aria-label="Outcome" value={params.get('outcome') ?? ''} onChange={(e) => update('outcome', e.target.value)} className={selectClass}>
          <option value="">Any outcome</option>
          <option value="SUCCESS">Succeeded</option>
          <option value="FAILURE">Failed</option>
        </select>
        {scope === 'platform' && (
          <select aria-label="Tenant" value={params.get('tenantId') ?? ''} onChange={(e) => update('tenantId', e.target.value)} className={`${selectClass} max-w-[200px]`}>
            <option value="">All tenants</option>
            {(tenants.data?.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
        <label className="flex items-center gap-1 text-sm text-slate-500">From
          <input type="date" aria-label="From date" value={params.get('from') ?? ''} onChange={(e) => update('from', e.target.value)} className={selectClass} />
        </label>
        <label className="flex items-center gap-1 text-sm text-slate-500">to
          <input type="date" aria-label="To date" value={params.get('to') ?? ''} onChange={(e) => update('to', e.target.value)} className={selectClass} />
        </label>
        {anyFilter && <button className="text-sm text-blue-600 hover:text-blue-700" onClick={() => setParams(new URLSearchParams(), { replace: true })}>Clear</button>}
      </div>

      {error ? <ErrorState error={error} onRetry={() => void load()} /> : rows.length === 0 && loading ? <LoadingState /> : rows.length === 0 ? (
        <Card><EmptyState title={anyFilter ? 'No entries match these filters' : 'Nothing recorded yet'} /></Card>
      ) : (
        <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-[13px] border-b border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400">
              <tr>
                <th className="w-8" />
                <th className="px-3 py-3 font-medium">When</th>
                <th className="px-3 py-3 font-medium">Who</th>
                <th className="px-3 py-3 font-medium">What</th>
                <th className="px-3 py-3 font-medium">Record</th>
                {scope === 'platform' && <th className="px-3 py-3 font-medium">Tenant</th>}
                <th className="px-3 py-3 font-medium">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
              {rows.map((e) => {
                const Actor = ACTORS[e.actorType].icon;
                const isOpen = open === e.id;
                return (
                  <Fragment key={e.id}>
                    <tr className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/40" onClick={() => setOpen(isOpen ? null : e.id)} aria-expanded={isOpen}>
                      <td className="pl-3 text-slate-400">{isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-slate-500" title={e.occurredAt}>{formatDateTime(e.occurredAt)}</td>
                      <td className="px-3 py-2.5">
                        <span className="flex items-center gap-2 text-slate-700 dark:text-slate-200">
                          <Actor size={14} className="text-slate-400 shrink-0" aria-label={ACTORS[e.actorType].label} />
                          <span className="truncate max-w-[220px]">{e.actorEmail ?? ACTORS[e.actorType].label}</span>
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-slate-800 dark:text-white">{labelOf(e.event)}</td>
                      <td className="px-3 py-2.5 text-slate-600 dark:text-slate-300 truncate max-w-[240px]">{e.resourceLabel ?? (e.resourceType ? humanize(e.resourceType) : '—')}</td>
                      {scope === 'platform' && <td className="px-3 py-2.5 text-slate-500">{tenantName(e.tenantId) ?? '—'}</td>}
                      <td className="px-3 py-2.5">
                        <span className={`inline-flex px-2 py-0.5 rounded-md text-xs font-medium ${e.outcome === 'SUCCESS'
                          ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300'
                          : 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300'}`}>
                          {e.outcome === 'SUCCESS' ? 'Succeeded' : 'Failed'}
                        </span>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-slate-50/60 dark:bg-slate-900/40">
                        <td />
                        <td colSpan={scope === 'platform' ? 6 : 5} className="px-3 py-4">
                          <EntryDetails entry={e} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {nextBefore && (
            <div className="p-3 text-center border-t border-slate-100 dark:border-slate-700">
              <button className={secondaryButtonClass} disabled={loading} onClick={() => void load(nextBefore)}>
                {loading && <Loader2 size={14} className="animate-spin" />}Load older entries
              </button>
            </div>
          )}
        </div>
      )}

      {canManage && (
        <Card
          title="Archives"
          description="Entries older than the retention period (a year by default) are moved to compressed files and kept there; checks continue across them."
          actions={
            <div className="flex gap-2 shrink-0 whitespace-nowrap">
              {scope === 'platform' && <button className={secondaryButtonClass} onClick={archiveNow}><Archive size={16} />Archive now</button>}
              <button className={secondaryButtonClass} onClick={() => setShowArchives(!showArchives)}>{showArchives ? 'Hide' : 'Show'} archives</button>
            </div>
          }
        >
          {archiving && <p role="status" className="mb-3 text-sm text-slate-600 dark:text-slate-300">{archiving}</p>}
          {showArchives && (archives.loading ? <LoadingState /> : !archives.data?.length ? (
            <p className="text-sm text-slate-500">Nothing archived yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-700 text-sm">
              {archives.data.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <span className="text-slate-700 dark:text-slate-200">
                    {scope === 'platform' && <span className="text-slate-400 mr-2">{a.chain === 'platform' ? 'Platform' : tenantName(a.chain) ?? a.chain}</span>}
                    #{a.fromSeq}–#{a.toSeq} · {new Date(a.fromAt).toLocaleDateString()} to {new Date(a.toAt).toLocaleDateString()} · {a.rows.toLocaleString()} entries · {(a.bytes / 1024).toFixed(1)} KB
                  </span>
                  <a className="text-blue-600 hover:text-blue-700 inline-flex items-center gap-1" href={`${API_URL}${base}/archives/${a.id}/download`} download>
                    <Download size={14} />Download
                  </a>
                </li>
              ))}
            </ul>
          ))}
        </Card>
      )}
    </div>
  );
}

function EntryDetails({ entry: e }: { entry: Entry }) {
  const changes = Object.entries(e.changes ?? {});
  const details = Object.entries(e.details ?? {});
  return (
    <div className="grid gap-4 lg:grid-cols-2 text-xs">
      <div className="space-y-3">
        {changes.length > 0 && (
          <div>
            <p className="font-semibold text-slate-600 dark:text-slate-300 mb-1">Changes</p>
            <table className="w-full">
              <thead className="text-slate-400"><tr><th className="text-left font-medium py-1">Field</th><th className="text-left font-medium">Before</th><th className="text-left font-medium">After</th></tr></thead>
              <tbody>
                {changes.map(([field, [before, after]]) => (
                  <tr key={field} className="align-top">
                    <td className="py-1 pr-3 text-slate-600 dark:text-slate-300">{humanize(field.replace(/([A-Z])/g, ' $1'))}</td>
                    <td className="py-1 pr-3 text-red-700 dark:text-red-300 break-all">{show(before)}</td>
                    <td className="py-1 text-green-700 dark:text-green-300 break-all">{show(after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {details.length > 0 && (
          <div>
            <p className="font-semibold text-slate-600 dark:text-slate-300 mb-1">Details</p>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
              {details.map(([k, v]) => (
                <Fragment key={k}><dt className="text-slate-400">{humanize(k.replace(/([A-Z])/g, ' $1'))}</dt><dd className="text-slate-700 dark:text-slate-200 break-all">{show(v)}</dd></Fragment>
              ))}
            </dl>
          </div>
        )}
        {changes.length === 0 && details.length === 0 && <p className="text-slate-400">No further details.</p>}
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 content-start">
        <dt className="text-slate-400">Entry</dt><dd className="text-slate-700 dark:text-slate-200">#{e.seq} · {e.event}</dd>
        <dt className="text-slate-400">Actor</dt><dd className="text-slate-700 dark:text-slate-200 break-all">{ACTORS[e.actorType].label}{e.actorId ? ` · ${e.actorId}` : ''}</dd>
        {e.resourceType && <><dt className="text-slate-400">Record</dt><dd className="text-slate-700 dark:text-slate-200 break-all">{e.resourceType}{e.resourceId ? ` · ${e.resourceId}` : ''}</dd></>}
        <dt className="text-slate-400">From</dt><dd className="text-slate-700 dark:text-slate-200 break-all">{e.ip ?? '—'}</dd>
        <dt className="text-slate-400">Browser</dt><dd className="text-slate-700 dark:text-slate-200 break-all">{e.userAgent ?? '—'}</dd>
        <dt className="text-slate-400">Request</dt><dd className="text-slate-700 dark:text-slate-200 break-all">{e.requestId ?? '—'}</dd>
        <dt className="text-slate-400">Signature</dt><dd className="font-mono text-slate-500 break-all">{e.hash}</dd>
      </dl>
    </div>
  );
}
