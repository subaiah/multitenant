import { Clock, Lock } from 'lucide-react';
import AppShell, { Mark } from '../components/AppShell';
import { useAuth } from '../contexts/AuthContext';

const DAY = 86_400_000;

/** A trial's end: a quiet note while there's time, a warning near it, read-only after it */
function TrialBanner({ endsAt, name }: { endsAt: string; name: string }) {
  const left = new Date(endsAt).getTime() - Date.now();
  const date = new Date(endsAt).toLocaleDateString(undefined, { dateStyle: 'medium' });
  if (left <= 0) {
    return (
      <div role="status" className="flex items-center gap-2 px-6 py-2.5 text-sm border-b border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
        <Lock size={15} aria-hidden className="shrink-0" />
        <span>{name}'s trial ended on {date}. Everything is still here to read, but changes are paused. Contact the platform team to continue.</span>
      </div>
    );
  }
  const days = Math.ceil(left / DAY);
  const soon = days <= 3;
  return (
    <div role="status" className={`flex items-center gap-2 px-6 py-2 text-sm border-b ${soon
      ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300'
      : 'border-slate-200 bg-white text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'}`}>
      <Clock size={15} aria-hidden className="shrink-0" />
      <span>Trial: {days === 1 ? '1 day' : `${days} days`} left (ends {date}).{soon && ' After that the organization becomes read-only until the platform team moves it to a paid plan.'}</span>
    </div>
  );
}

export default function TenantLayout() {
  const { tenant } = useAuth();
  const name = tenant?.name ?? 'Your organization';
  return (
    <AppShell
      portal="TENANT"
      mark={<Mark label={name} color={tenant?.primaryColor} logoUrl={tenant?.logoUrl} />}
      title={name}
      subtitle="Organization"
      notificationsPath="/notifications"
      banner={tenant?.status === 'TRIAL' && tenant.trialEndsAt ? <TrialBanner endsAt={tenant.trialEndsAt} name={name} /> : undefined}
    />
  );
}
