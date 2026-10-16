/**
 * The bell: unread count (checked every 30 seconds and when the window gets
 * focus, as a background request so it doesn't keep an idle session alive)
 * and the latest notifications.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck } from 'lucide-react';
import { apiGet, apiPost } from '../lib/api-client';
import { formatRelative } from './ui';

export interface InboxItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

const POLL_MS = 30_000;

export default function NotificationBell({ allPath, dark = false }: { allPath: string; dark?: boolean }) {
  const navigate = useNavigate();
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  const refreshCount = useCallback(async () => {
    try {
      setCount((await apiGet<{ count: number }>('/notifications/unread-count', { background: true })).count);
    } catch {
      /* signed out or offline: try again later */
    }
  }, []);

  useEffect(() => {
    void refreshCount();
    const timer = setInterval(() => document.visibilityState === 'visible' && void refreshCount(), POLL_MS);
    const onFocus = () => void refreshCount();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshCount]);

  // Close on a click outside or Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => panel.current && !panel.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = async () => {
    if (open) return setOpen(false);
    setOpen(true);
    setItems(null);
    try {
      const page = await apiGet<{ data: InboxItem[]; unread: number }>('/notifications?limit=8');
      setItems(page.data);
      setCount(page.unread);
    } catch {
      setItems([]);
    }
  };

  const openItem = async (n: InboxItem) => {
    if (!n.readAt) {
      await apiPost('/notifications/read', { ids: [n.id] }).catch(() => {});
      setCount((c) => Math.max(0, c - 1));
    }
    setOpen(false);
    if (n.link) navigate(n.link);
  };

  const readAll = async () => {
    await apiPost('/notifications/read', {}).catch(() => {});
    setCount(0);
    setItems((list) => list?.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })) ?? null);
  };

  return (
    <div className="relative" ref={panel}>
      <button
        onClick={toggle}
        aria-label={count ? `Notifications, ${count} unread` : 'Notifications'}
        aria-expanded={open}
        className={`relative p-2 rounded-lg transition-colors ${dark ? 'text-slate-300 hover:bg-slate-700' : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700'}`}
      >
        <Bell size={20} />
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[11px] font-semibold leading-[18px] text-center">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>
      {open && (
        <div role="dialog" aria-label="Notifications" className="absolute left-full top-0 ml-2 z-50 w-96 max-h-[70vh] flex flex-col bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl text-slate-800 dark:text-slate-100">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 dark:border-slate-700">
            <p className="font-semibold text-sm">Notifications</p>
            {count > 0 && (
              <button onClick={readAll} className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700">
                <CheckCheck size={14} />Mark all read
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto">
            {items === null ? (
              <p className="p-4 text-sm text-slate-400">Loading…</p>
            ) : items.length === 0 ? (
              <p className="p-6 text-sm text-center text-slate-500">You're all caught up.</p>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-700">
                {items.map((n) => (
                  <li key={n.id}>
                    <button onClick={() => void openItem(n)} className="w-full text-left px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-700/50 flex gap-3">
                      <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${n.readAt ? 'bg-transparent' : 'bg-blue-600'}`} aria-hidden />
                      <span className="min-w-0">
                        <span className={`block text-sm ${n.readAt ? 'text-slate-600 dark:text-slate-300' : 'font-semibold'}`}>{n.title}</span>
                        {n.body && <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-2">{n.body}</span>}
                        <span className="block text-xs text-slate-400 mt-1">{formatRelative(n.createdAt)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button onClick={() => { setOpen(false); navigate(allPath); }} className="px-4 py-2.5 text-sm text-blue-600 hover:bg-slate-50 dark:hover:bg-slate-700/50 border-t border-slate-100 dark:border-slate-700 rounded-b-xl">
            See all and choose what you get
          </button>
        </div>
      )}
    </div>
  );
}
