/**
 * Shared building blocks, so every page handles loading, errors and empty
 * results the same way and looks the same. Colours and fonts are the tokens
 * in src/index.css.
 */
import { ReactNode, useEffect, useRef, useState } from 'react';
import { AlertCircle, Inbox, MoreHorizontal, RefreshCw, type LucideIcon } from 'lucide-react';

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-800 dark:text-white">{title}</h1>
        {description && <p className="text-sm text-slate-600 dark:text-slate-400 mt-1 max-w-prose">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, description, actions, children, className = '' }: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`bg-white dark:bg-slate-800 rounded-lg p-5 border border-slate-200 dark:border-slate-700 ${className}`}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            {title && <h2 className="text-[15px] font-semibold text-slate-800 dark:text-white">{title}</h2>}
            {description && <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * Stat icons are quiet by default; colour is kept for what needs attention
 * (red, amber) or a clear good state (green). Other tones read as neutral.
 */
const TONES = {
  blue: { bg: 'bg-slate-100 dark:bg-slate-700/60', icon: 'text-slate-600 dark:text-slate-300' },
  green: { bg: 'bg-green-50 dark:bg-green-500/10', icon: 'text-green-700 dark:text-green-400' },
  purple: { bg: 'bg-slate-100 dark:bg-slate-700/60', icon: 'text-slate-600 dark:text-slate-300' },
  amber: { bg: 'bg-amber-50 dark:bg-amber-500/10', icon: 'text-amber-700 dark:text-amber-400' },
  red: { bg: 'bg-red-50 dark:bg-red-500/10', icon: 'text-red-600 dark:text-red-400' },
  slate: { bg: 'bg-slate-100 dark:bg-slate-700/60', icon: 'text-slate-600 dark:text-slate-300' },
} as const;
export type Tone = keyof typeof TONES;

export function StatCard({ label, value, icon: Icon, tone = 'blue', hint }: {
  label: string;
  value: ReactNode;
  icon: LucideIcon;
  tone?: Tone;
  hint?: ReactNode;
}) {
  const t = TONES[tone];
  return (
    <div className="bg-white dark:bg-slate-800 rounded-lg p-5 border border-slate-200 dark:border-slate-700">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-slate-600 dark:text-slate-400">{label}</p>
        <div className={`p-2 rounded-md ${t.bg}`}>
          <Icon size={18} strokeWidth={1.75} className={t.icon} aria-hidden />
        </div>
      </div>
      <p className="mt-2 text-[28px] leading-none font-semibold tracking-tight text-slate-800 dark:text-white tabular-nums">{value}</p>
      {hint && <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">{hint}</div>}
    </div>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-sm text-slate-500 dark:text-slate-400" role="status">
      <div className="animate-spin rounded-full h-5 w-5 border-2 border-slate-300 border-t-blue-600" />
      {label}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center" role="alert">
      <AlertCircle className="text-red-500" size={28} />
      <div>
        <p className="text-sm font-medium text-slate-800 dark:text-white">Couldn't load this data</p>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{error}</p>
      </div>
      {onRetry && (
        <button onClick={onRetry} className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700">
          <RefreshCw size={14} /> Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({ icon: Icon = Inbox, title, message, action }: {
  icon?: LucideIcon;
  title: string;
  message?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <Icon className="text-slate-300 dark:text-slate-600" size={32} />
      <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{title}</p>
      {message && <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md">{message}</p>}
      {action}
    </div>
  );
}

/** Loading / error wrapper: renders children only once data is available. */
export function DataView<T>({ data, error, loading, reload, children }: {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  children: (data: T) => ReactNode;
}) {
  if (loading && data === null) return <LoadingState />;
  if (error && data === null) return <ErrorState error={error} onRetry={reload} />;
  if (data === null) return null;
  return <>{children(data)}</>;
}

const BADGE: Record<string, string> = {
  ACTIVE: 'bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-400',
  RUNNING: 'bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-400',
  VERIFIED: 'bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-400',
  TRIAL: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  DEPLOYING: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  PENDING: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  INVITED: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  SCHEDULED: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  EXPIRED: 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400',
  SUSPENDED: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  CLOSING: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  TRIAL_ENDED: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  ERROR: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  INACTIVE: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
  PAST_DUE: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  INCOMPLETE: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  UNPAID: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  CANCELED: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
  PAID: 'bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-400',
  DELIVERED: 'bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-400',
  FAILED: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  REVOKED: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
  SENDING: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  STOPPED: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
};

export function Badge({ value, className = '' }: { value: string; className?: string }) {
  const style = BADGE[value] ?? 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${style} ${className}`}>
      {humanize(value)}
    </span>
  );
}

/** ENTERPRISE -> Enterprise, SHARED_TABLES -> Shared tables */
export function humanize(value: string) {
  const s = value.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatDate(value: string | Date | null | undefined) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** 16 Oct 2026, 18:19 (in the reader's own locale and time zone) */
export function formatDateTime(value: string | Date | null | undefined) {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatRelative(value: string | Date | null | undefined) {
  if (!value) return 'Never';
  const diff = Date.now() - new Date(value).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'Yesterday';
  if (d < 30) return `${d} days ago`;
  return formatDate(value);
}

/**
 * Chart colours (Recharts draws SVG attributes, which can't read the CSS
 * tokens): the accent for single series, and grid and axis greys per theme.
 */
export function chartColors(dark: boolean) {
  return {
    accent: dark ? '#3aa894' : '#0b7a6a',
    grid: dark ? '#2b3443' : '#e6e9ee',
    axis: dark ? '#8b94a3' : '#687182',
  };
}

/** Categories that must be told apart (distinct in lightness as well as hue) */
export const CATEGORY_COLORS = ['#0b7a6a', '#5b63d3', '#c98a1a', '#9aa2af'];

export const CHART_TOOLTIP = {
  contentStyle: { backgroundColor: '#1d2532', border: 'none', borderRadius: '6px', color: '#fff', fontSize: '12px' },
};

export const inputClass =
  'w-full px-3 py-2 text-sm rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-white placeholder:text-slate-400 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/25';

/** For filter dropdowns that should size to their content. */
export const selectClass =
  'px-3 py-2 text-sm rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-white focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/25';

export const primaryButtonClass =
  'inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-md bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 disabled:cursor-not-allowed';

export const secondaryButtonClass =
  'inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50';

/** Initials in a circle, for people in lists */
export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const words = name.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  const text = ((words[0]?.[0] ?? '') + (words.length > 1 ? words[words.length - 1][0] : words[0]?.[1] ?? '')).toUpperCase();
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-100 font-semibold"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
    >
      {text}
    </span>
  );
}

export interface MenuAction {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

/**
 * The "more actions" button of a row: the less common actions, out of the
 * way. Escape or a click outside closes it.
 */
export function ActionsMenu({ label, actions }: { label: string; actions: MenuAction[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  if (actions.length === 0) return null;
  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="p-1.5 rounded-md text-slate-500 hover:text-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 dark:hover:text-white"
      >
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full mt-1 z-30 min-w-44 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                a.onSelect();
              }}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-700 ${a.danger ? 'text-red-600 dark:text-red-400' : 'text-slate-700 dark:text-slate-200'}`}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
