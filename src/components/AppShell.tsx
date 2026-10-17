/**
 * The frame around every signed-in page, in both portals: the graphite
 * sidebar (who you are and where, the menu, your account) and the page.
 * Below the lg breakpoint the sidebar slides in from a menu button.
 */
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { LogOut, Menu, Moon, Sun, X } from 'lucide-react';
import DynamicMenu from './DynamicMenu';
import NotificationBell from './NotificationBell';
import { LoadingState, humanize } from './ui';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';

export function initials(name: string) {
  const words = name.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words.length > 1 ? words[words.length - 1][0] : words[0]?.[1] ?? '')).toUpperCase();
}

export default function AppShell({ portal, mark, title, subtitle, notificationsPath }: {
  portal: 'PLATFORM' | 'TENANT';
  /** The square at the top: the organization's or the product's */
  mark: ReactNode;
  title: string;
  subtitle: string;
  notificationsPath: string;
}) {
  const { user, logout } = useAuth();
  const { dark, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);

  const name = user?.name || user?.email || '';
  const sidebar = (
    <aside className="w-64 h-full bg-sidebar text-sidebar-ink flex flex-col border-r border-sidebar-line">
      <div className="flex items-start gap-3 px-4 pt-5 pb-6">
        {mark}
        <div className="min-w-0 flex-1">
          <p className="text-[15px] leading-snug font-semibold text-white break-words">{title}</p>
          <p className="text-xs text-sidebar-muted">{subtitle}</p>
        </div>
        <NotificationBell allPath={notificationsPath} dark />
      </div>

      <div className="flex-1 overflow-y-auto pb-6">
        <DynamicMenu portal={portal} onNavigate={() => setOpen(false)} />
      </div>

      <div className="border-t border-sidebar-line px-4 py-3 flex items-center gap-3">
        <div aria-hidden className="w-8 h-8 shrink-0 rounded-full bg-sidebar-raised text-white text-xs font-semibold flex items-center justify-center">
          {initials(name)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white truncate">{name}</p>
          <p className="text-xs text-sidebar-muted truncate">{user ? humanize(user.userType.replace(/^(PLATFORM|TENANT)_/, '')) : ''}</p>
        </div>
        <button
          onClick={toggle}
          aria-label={dark ? 'Use light theme' : 'Use dark theme'}
          title={dark ? 'Light theme' : 'Dark theme'}
          className="p-2 rounded-md text-sidebar-muted hover:text-white hover:bg-sidebar-raised"
        >
          {dark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <button
          onClick={logout}
          aria-label="Sign out"
          title="Sign out"
          className="p-2 rounded-md text-sidebar-muted hover:text-white hover:bg-sidebar-raised"
        >
          <LogOut size={16} />
        </button>
      </div>
    </aside>
  );

  return (
    <div className="flex h-screen bg-slate-50 dark:bg-slate-900">
      <div className="hidden lg:block shrink-0">{sidebar}</div>

      {/* Narrow screens: the sidebar over the page */}
      {open && (
        <div className="lg:hidden fixed inset-0 z-40 flex">
          <div className="relative">{sidebar}</div>
          <button aria-label="Close menu" className="flex-1 bg-slate-950/40" onClick={() => setOpen(false)} />
        </div>
      )}

      <div className="flex-1 min-w-0 flex flex-col">
        <div className="lg:hidden flex items-center gap-3 px-4 h-14 bg-sidebar text-white">
          <button onClick={() => setOpen(true)} aria-label="Open menu" aria-expanded={open} className="p-2 -ml-2 rounded-md hover:bg-sidebar-raised">
            {open ? <X size={20} /> : <Menu size={20} />}
          </button>
          <span className="font-semibold truncate">{title}</span>
        </div>
        <main className="flex-1 overflow-auto">
          <Suspense fallback={<LoadingState />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}

/** A square with an initial: the organization's, or the product's */
export function Mark({ label, color, logoUrl }: { label: string; color?: string | null; logoUrl?: string | null }) {
  if (logoUrl) return <img src={logoUrl} alt="" className="w-9 h-9 shrink-0 rounded-md object-contain bg-white" />;
  return (
    <div
      aria-hidden
      className="w-9 h-9 shrink-0 rounded-md flex items-center justify-center text-white font-semibold"
      style={{ backgroundColor: color ?? 'var(--color-blue-600)' }}
    >
      {label.trim().charAt(0).toUpperCase()}
    </div>
  );
}
