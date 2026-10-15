/**
 * Small shared building blocks so every data page handles loading, errors and
 * empty results the same way, in the app's existing visual style.
 */
import { ReactNode } from 'react';
import { AlertCircle, Inbox, RefreshCw, type LucideIcon } from 'lucide-react';

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 className="text-xl font-bold text-slate-800 dark:text-white">{title}</h2>
        {description && <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{description}</p>}
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
    <section className={`bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700 ${className}`}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            {title && <h3 className="text-base font-semibold text-slate-800 dark:text-white">{title}</h3>}
            {description && <p className="text-sm text-slate-500 dark:text-slate-400">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

const TONES = {
  blue: { bg: 'bg-blue-50 dark:bg-blue-500/10', icon: 'text-blue-500' },
  green: { bg: 'bg-green-50 dark:bg-green-500/10', icon: 'text-green-500' },
  purple: { bg: 'bg-purple-50 dark:bg-purple-500/10', icon: 'text-purple-500' },
  amber: { bg: 'bg-amber-50 dark:bg-amber-500/10', icon: 'text-amber-500' },
  red: { bg: 'bg-red-50 dark:bg-red-500/10', icon: 'text-red-500' },
  slate: { bg: 'bg-slate-100 dark:bg-slate-700', icon: 'text-slate-500' },
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
    <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
      <div className="flex items-center justify-between">
        <div className={`p-2.5 rounded-lg ${t.bg}`}>
          <Icon size={20} className={t.icon} />
        </div>
        {hint && <div className="text-xs text-slate-500 dark:text-slate-400 text-right">{hint}</div>}
      </div>
      <p className="mt-4 text-2xl font-bold text-slate-800 dark:text-white tabular-nums">{value}</p>
      <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{label}</p>
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
        <button onClick={onRetry} className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700">
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
  TRIAL: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  DEPLOYING: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  PENDING: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  SUSPENDED: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  ERROR: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  INACTIVE: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
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

export function formatRelative(value: string | Date | null | undefined) {
  if (!value) return 'Never';
  const diff = Date.now() - new Date(value).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return formatDate(value);
}

export const CHART_TOOLTIP = {
  contentStyle: { backgroundColor: '#1e293b', border: 'none', borderRadius: '8px', color: '#fff', fontSize: '12px' },
};

export const inputClass =
  'w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500';

/** For filter dropdowns that should size to their content. */
export const selectClass =
  'px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500';

export const primaryButtonClass =
  'inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 disabled:cursor-not-allowed';

export const secondaryButtonClass =
  'inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50';
