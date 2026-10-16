/**
 * Notifications: your inbox, what you get and how (preferences), and for
 * tenant admins, what the organization sends (Organization).
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCheck, Lock, Loader2, RotateCw } from 'lucide-react';
import { apiGet, apiPost, apiPut } from '../lib/api-client';
import { useAuth } from '../contexts/AuthContext';
import { Card, EmptyState, ErrorState, LoadingState, PageHeader, formatRelative, primaryButtonClass, secondaryButtonClass, formatDateTime } from '../components/ui';
import type { InboxItem } from '../components/NotificationBell';

interface Channels { inApp: boolean; email: boolean }
interface Preference {
  type: string;
  label: string;
  description: string;
  category: string;
  mandatory: boolean;
  allowed: Channels;
  current: Channels;
  defaults: Channels;
}
interface OrgType {
  type: string;
  label: string;
  description: string;
  category: string;
  required: boolean;
  defaults: Channels;
  setting: { enabled: boolean; inApp: boolean; email: boolean; mandatory: boolean };
}
interface FailedEmail { id: string; to: string; subject: string; attempts: number; lastError: string | null; createdAt: string }

const CATEGORY_LABELS: Record<string, string> = {
  security: 'Security',
  account: 'Your account',
  access: 'Access',
  settings: 'Organization settings',
  support: 'Support',
  tenants: 'Tenants',
  product: 'Other',
};
const groupBy = <T extends { category: string }>(list: T[]) =>
  Object.entries(list.reduce<Record<string, T[]>>((acc, x) => ((acc[x.category] ??= []).push(x), acc), {}));

export default function Notifications({ scope }: { scope: 'tenant' | 'platform' }) {
  const { hasPermission } = useAuth();
  const [params, setParams] = useSearchParams();
  const canManage = scope === 'tenant' && hasPermission('notifications:manage');
  const tabs = [
    { id: 'inbox', label: 'Inbox' },
    { id: 'preferences', label: 'My preferences' },
    ...(canManage ? [{ id: 'organization', label: 'Organization' }] : []),
  ];
  const tab = tabs.some((t) => t.id === params.get('tab')) ? params.get('tab')! : 'inbox';

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Notifications" description="What's happened that concerns you, and how you hear about it" />
      <div role="tablist" className="flex gap-1 border-b border-slate-200 dark:border-slate-700">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setParams({ tab: t.id }, { replace: true })}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === t.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'inbox' && <Inbox />}
      {tab === 'preferences' && <Preferences />}
      {tab === 'organization' && canManage && <Organization />}
    </div>
  );
}

function Inbox() {
  const navigate = useNavigate();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (before?: string) => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({ limit: '25', ...(unreadOnly && { unread: 'true' }), ...(before && { before }) });
      const page = await apiGet<{ data: InboxItem[]; nextBefore: string | null; unread: number }>(`/notifications?${q}`);
      setItems((prev) => (before ? [...prev, ...page.data] : page.data));
      setNext(page.nextBefore);
      setUnread(page.unread);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load notifications');
    } finally {
      setLoading(false);
    }
  }, [unreadOnly]);
  useEffect(() => void load(), [load]);

  const markRead = async (ids?: string[]) => {
    await apiPost('/notifications/read', ids ? { ids } : {});
    const now = new Date().toISOString();
    setItems((list) => list.map((n) => (!ids || ids.includes(n.id) ? { ...n, readAt: n.readAt ?? now } : n)));
    setUnread((u) => (ids ? Math.max(0, u - ids.length) : 0));
  };

  if (error) return <ErrorState error={error} onRetry={() => void load()} />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />Unread only
        </label>
        <span className="text-sm text-slate-400">{unread} unread</span>
        {unread > 0 && (
          <button className={`${secondaryButtonClass} ml-auto`} onClick={() => void markRead()}><CheckCheck size={16} />Mark all read</button>
        )}
      </div>
      {items.length === 0 && loading ? <LoadingState /> : items.length === 0 ? (
        <Card><EmptyState title={unreadOnly ? 'Nothing unread' : 'No notifications yet'} message="You'll see changes to your access, security notices and anything else that concerns you here." /></Card>
      ) : (
        <Card className="!p-0">
          <ul className="divide-y divide-slate-100 dark:divide-slate-700">
            {items.map((n) => (
              <li key={n.id} className="flex items-start gap-3 px-5 py-3">
                <span className={`mt-2 w-2 h-2 rounded-full shrink-0 ${n.readAt ? 'bg-transparent' : 'bg-blue-600'}`} aria-label={n.readAt ? undefined : 'Unread'} />
                <div className="min-w-0 flex-1">
                  <button className="text-left" onClick={() => { void markRead([n.id]); if (n.link) navigate(n.link); }}>
                    <p className={`text-sm ${n.readAt ? 'text-slate-700 dark:text-slate-200' : 'font-semibold text-slate-900 dark:text-white'}`}>{n.title}</p>
                    {n.body && <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{n.body}</p>}
                  </button>
                  <p className="text-xs text-slate-400 mt-1" title={formatDateTime(n.createdAt)}>{formatRelative(n.createdAt)}</p>
                </div>
                {!n.readAt && (
                  <button className="text-xs text-blue-600 hover:text-blue-700 shrink-0" onClick={() => void markRead([n.id])}>Mark read</button>
                )}
              </li>
            ))}
          </ul>
          {next && (
            <div className="p-3 text-center border-t border-slate-100 dark:border-slate-700">
              <button className={secondaryButtonClass} disabled={loading} onClick={() => void load(next)}>
                {loading && <Loader2 size={14} className="animate-spin" />}Older
              </button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function Preferences() {
  const [prefs, setPrefs] = useState<Preference[] | null>(null);
  const [draft, setDraft] = useState<Record<string, Channels>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiGet<Preference[]>('/notifications/preferences').then(setPrefs).catch((err) => setError(err.message));
  }, []);
  const groups = useMemo(() => groupBy(prefs ?? []), [prefs]);
  const value = (p: Preference) => draft[p.type] ?? p.current;
  const dirty = Object.keys(draft).length > 0;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      setPrefs(await apiPut<Preference[]>('/notifications/preferences', { preferences: draft }));
      setDraft({});
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  if (error && !prefs) return <ErrorState error={error} />;
  if (!prefs) return <LoadingState />;
  return (
    <Card
      title="What you get, and how"
      description="Security notices can't be turned off. Channels your organization has turned off are greyed out."
      actions={
        <div className="flex items-center gap-3">
          {saved && <span role="status" className="text-sm text-green-600">Saved</span>}
          <button className={primaryButtonClass} disabled={!dirty || saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      }
    >
      {error && <p role="alert" className="mb-3 text-sm text-red-600">{error}</p>}
      <table className="w-full text-sm">
        <thead className="text-[13px] text-slate-500">
          <tr><th className="text-left font-medium py-2">Notification</th><th className="w-24 font-medium">In app</th><th className="w-24 font-medium">Email</th></tr>
        </thead>
        <tbody>
          {groups.map(([category, list]) => (
            <Fragment key={category}>
              <tr><td colSpan={3} className="pt-4 pb-1 text-xs font-semibold text-slate-400">{CATEGORY_LABELS[category] ?? category}</td></tr>
              {list.map((p) => (
                <tr key={p.type} className="border-t border-slate-100 dark:border-slate-700">
                  <td className="py-2.5 pr-4">
                    <p className="text-slate-800 dark:text-white flex items-center gap-1.5">
                      {p.label}
                      {p.mandatory && <span className="inline-flex items-center gap-1 text-xs text-slate-400"><Lock size={12} />Required</span>}
                    </p>
                    <p className="text-xs text-slate-500">{p.description}</p>
                  </td>
                  {(['inApp', 'email'] as const).map((ch) => (
                    <td key={ch} className="text-center">
                      <input
                        type="checkbox"
                        aria-label={`${p.label}: ${ch === 'inApp' ? 'in app' : 'email'}`}
                        checked={value(p)[ch]}
                        disabled={p.mandatory || !p.allowed[ch]}
                        title={!p.allowed[ch] ? 'Turned off by your organization' : p.mandatory ? 'Required' : undefined}
                        onChange={(e) => setDraft({ ...draft, [p.type]: { ...value(p), [ch]: e.target.checked } })}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function Organization() {
  const [data, setData] = useState<{ types: OrgType[]; delivery: { failedEmails: number; pending: number } } | null>(null);
  const [draft, setDraft] = useState<Record<string, OrgType['setting']>>({});
  const [failed, setFailed] = useState<FailedEmail[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await apiGet('/notification-settings'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load settings');
    }
  }, []);
  useEffect(() => void load(), [load]);

  const groups = useMemo(() => groupBy(data?.types ?? []), [data]);
  const value = (t: OrgType) => draft[t.type] ?? t.setting;
  const change = (t: OrgType, key: keyof OrgType['setting'], v: boolean) => setDraft({ ...draft, [t.type]: { ...value(t), [key]: v } });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiPut('/notification-settings', { settings: draft });
      await load();
      setDraft({});
      setMessage('Saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };
  const showFailed = async () => setFailed(await apiGet<FailedEmail[]>('/notification-settings/failed-emails'));
  const retry = async () => {
    const r = await apiPost<{ retried: number }>('/notification-settings/failed-emails/retry');
    setMessage(`${r.retried} email${r.retried === 1 ? '' : 's'} queued again`);
    setFailed(null);
    await load();
  };

  if (error && !data) return <ErrorState error={error} />;
  if (!data) return <LoadingState />;
  return (
    <div className="space-y-6">
      <Card
        title="What your organization sends"
        description="Turn notifications off, limit them to in-app or email, or require them for everyone. Security notices are always on."
        actions={
          <div className="flex items-center gap-3">
            {message && <span role="status" className="text-sm text-green-600">{message}</span>}
            <button className={primaryButtonClass} disabled={!Object.keys(draft).length || saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        }
      >
        {error && <p role="alert" className="mb-3 text-sm text-red-600">{error}</p>}
        <table className="w-full text-sm">
          <thead className="text-[13px] text-slate-500">
            <tr>
              <th className="text-left font-medium py-2">Notification</th>
              <th className="w-20 font-medium">On</th>
              <th className="w-24 font-medium">In app</th>
              <th className="w-20 font-medium">Email</th>
              <th className="w-36 font-medium">Required for everyone</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(([category, list]) => (
              <Fragment key={category}>
                <tr><td colSpan={5} className="pt-4 pb-1 text-xs font-semibold text-slate-400">{CATEGORY_LABELS[category] ?? category}</td></tr>
                {list.map((t) => {
                  const v = value(t);
                  return (
                    <tr key={t.type} className="border-t border-slate-100 dark:border-slate-700">
                      <td className="py-2.5 pr-4">
                        <p className="text-slate-800 dark:text-white flex items-center gap-1.5">{t.label}{t.required && <span className="inline-flex items-center gap-1 text-xs text-slate-400"><Lock size={12} />Security notice</span>}</p>
                        <p className="text-xs text-slate-500">{t.description} · default: {[t.defaults.inApp && 'in app', t.defaults.email && 'email'].filter(Boolean).join(' and ') || 'off'}</p>
                      </td>
                      <td className="text-center"><input type="checkbox" aria-label={`${t.label}: on`} checked={t.required || v.enabled} disabled={t.required} onChange={(e) => change(t, 'enabled', e.target.checked)} /></td>
                      <td className="text-center"><input type="checkbox" aria-label={`${t.label}: in app allowed`} checked={v.inApp} disabled={!v.enabled && !t.required} onChange={(e) => change(t, 'inApp', e.target.checked)} /></td>
                      <td className="text-center"><input type="checkbox" aria-label={`${t.label}: email allowed`} checked={v.email} disabled={!v.enabled && !t.required} onChange={(e) => change(t, 'email', e.target.checked)} /></td>
                      <td className="text-center"><input type="checkbox" aria-label={`${t.label}: required`} checked={t.required || v.mandatory} disabled={t.required || !v.enabled} onChange={(e) => change(t, 'mandatory', e.target.checked)} /></td>
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Email delivery" description="Emails are retried for about a day before they are given up on.">
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <span className="text-slate-600 dark:text-slate-300">{data.delivery.pending} waiting · <span className={data.delivery.failedEmails ? 'text-red-600 font-medium' : ''}>{data.delivery.failedEmails} failed</span></span>
          {data.delivery.failedEmails > 0 && (
            <>
              <button className={secondaryButtonClass} onClick={showFailed}>Show failed</button>
              <button className={secondaryButtonClass} onClick={retry}><RotateCw size={14} />Try again</button>
            </>
          )}
        </div>
        {failed && (
          <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-700 text-sm">
            {failed.map((f) => (
              <li key={f.id} className="py-2">
                <p className="text-slate-800 dark:text-white">{f.subject} → {f.to}</p>
                <p className="text-xs text-red-600">{f.lastError} · {f.attempts} attempts · {formatRelative(f.createdAt)}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
