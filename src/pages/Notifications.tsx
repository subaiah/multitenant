/**
 * Notifications: your inbox, what you get and how (preferences), and for
 * tenant admins, what the organization sends (Organization).
 */
import { Fragment, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCheck, Lock, Loader2, RotateCw } from 'lucide-react';
import { apiGet, apiPost, apiPut } from '../lib/api-client';
import { useApi } from '../hooks/useApi';
import { useInfiniteQuery } from '@tanstack/react-query';
import { apiKey, invalidateApi } from '../lib/query';
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

/** Sends a test email to the signed-in person and says what happened */
function TestEmailButton({ path }: { path: string }) {
  const [state, setState] = useState<{ busy: boolean; result?: { sent: boolean; to: string; error?: string }; failed?: string }>({ busy: false });
  const send = async () => {
    setState({ busy: true });
    try {
      setState({ busy: false, result: await apiPost(path) });
    } catch (err) {
      setState({ busy: false, failed: err instanceof Error ? err.message : 'Could not send' });
    }
  };
  const r = state.result;
  return (
    <div className="flex flex-wrap items-center justify-end gap-3">
      {r?.sent && <span role="status" className="text-sm text-green-700 dark:text-green-400">Sent to {r.to}. Check that inbox (and spam).</span>}
      {(r && !r.sent) && <span role="alert" className="text-sm text-red-600">Not sent: {r.error}</span>}
      {state.failed && <span role="alert" className="text-sm text-red-600">{state.failed}</span>}
      <button className={secondaryButtonClass} onClick={send} disabled={state.busy}>{state.busy ? 'Sending…' : 'Send a test email'}</button>
    </div>
  );
}

/** Platform: where email goes, and a test message */
function PlatformEmail() {
  const email = useApi<{ transport: string; from: string; smtp: { host: string; port: number; secure: boolean; user: string | null } | null }>('/platform/email');
  const setup = email.data;
  const error = email.error;
  if (error) return <ErrorState error={error} />;
  if (!setup) return <LoadingState />;
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex gap-4 py-2 border-t border-slate-100 dark:border-slate-700 first:border-0"><dt className="w-32 shrink-0 text-slate-500">{label}</dt><dd className="font-mono text-slate-800 dark:text-slate-100 break-all">{value}</dd></div>
  );
  return (
    <Card title="Email delivery" description="Invitations, password resets, sign-in codes, sign-up confirmations and notifications. Set in the server's .env (SMTP_URL, MAIL_FROM)." actions={<TestEmailButton path="/platform/email/test" />}>
      <dl className="text-sm">
        {row('Sender', setup.from)}
        {row('Transport', setup.transport === 'smtp' ? 'SMTP' : `${setup.transport} (emails are not delivered)`)}
        {setup.smtp && row('Server', `${setup.smtp.host}:${setup.smtp.port}${setup.smtp.secure ? ' (TLS)' : ' (STARTTLS)'}`)}
        {setup.smtp?.user && row('Username', setup.smtp.user)}
      </dl>
    </Card>
  );
}

export default function Notifications({ scope }: { scope: 'tenant' | 'platform' }) {
  const { hasPermission } = useAuth();
  const [params, setParams] = useSearchParams();
  const canManage = scope === 'tenant' && hasPermission('notifications:manage');
  const canManageEmail = scope === 'platform' && hasPermission('platform-settings:manage');
  const tabs = [
    { id: 'inbox', label: 'Inbox' },
    { id: 'preferences', label: 'My preferences' },
    ...(canManage ? [{ id: 'organization', label: 'Organization' }] : []),
    ...(canManageEmail ? [{ id: 'email', label: 'Email' }] : []),
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
      {tab === 'email' && canManageEmail && <PlatformEmail />}
    </div>
  );
}

function Inbox() {
  const navigate = useNavigate();
  const [unreadOnly, setUnreadOnly] = useState(false);
  type Page = { data: InboxItem[]; nextBefore: string | null; unread: number };
  const pages = useInfiniteQuery({
    queryKey: [...apiKey('/notifications'), { unreadOnly }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ limit: '25', ...(unreadOnly && { unread: 'true' }), ...(pageParam && { before: pageParam }) });
      return apiGet<Page>(`/notifications?${q}`);
    },
    getNextPageParam: (last: Page) => last.nextBefore ?? undefined,
  });
  const items = useMemo(() => pages.data?.pages.flatMap((p) => p.data) ?? [], [pages.data]);
  const unread = pages.data?.pages[0]?.unread ?? 0;
  const next = pages.hasNextPage;
  const loading = pages.isFetching;
  const error = pages.error ? (pages.error instanceof Error ? pages.error.message : 'Could not load notifications') : null;
  const load = () => pages.refetch();

  // The inbox and the bell's count
  const markRead = async (ids?: string[]) => {
    await apiPost('/notifications/read', ids ? { ids } : {});
    await invalidateApi('/notifications');
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
              <button className={secondaryButtonClass} disabled={loading} onClick={() => void pages.fetchNextPage()}>
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
  const stored = useApi<Preference[]>('/notifications/preferences');
  const prefs = stored.data;
  const [draft, setDraft] = useState<Record<string, Channels>>({});
  const [saveError, setError] = useState<string | null>(null);
  const error = saveError ?? stored.error;
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const groups = useMemo(() => groupBy(prefs ?? []), [prefs]);
  const value = (p: Preference) => draft[p.type] ?? p.current;
  const dirty = Object.keys(draft).length > 0;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiPut<Preference[]>('/notifications/preferences', { preferences: draft });
      await invalidateApi('/notifications/preferences');
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
  const settings = useApi<{ types: OrgType[]; delivery: { failedEmails: number; pending: number } }>('/notification-settings');
  const data = settings.data;
  const [draft, setDraft] = useState<Record<string, OrgType['setting']>>({});
  const [failed, setFailed] = useState<FailedEmail[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saveError, setError] = useState<string | null>(null);
  const error = saveError ?? settings.error;
  const [saving, setSaving] = useState(false);
  const load = () => invalidateApi('/notification-settings');

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

      <Card title="Email delivery" description="Emails are retried for about a day before they are given up on." actions={<TestEmailButton path="/notification-settings/test-email" />}>
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
