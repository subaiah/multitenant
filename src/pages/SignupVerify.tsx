/**
 * The link from the sign-up email: confirms it (which creates the
 * organization), then follows the setup until it's ready to sign in to.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { apiGet, apiPost } from '../lib/api-client';
import { AuthCard, authButtonClass } from '../components/AuthCard';

type Phase =
  | { kind: 'confirming' }
  | { kind: 'setting-up'; organization: string; slug: string; email: string }
  | { kind: 'ready'; organization: string; slug: string; email: string }
  | { kind: 'failed'; message: string };

export default function SignupVerify() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [phase, setPhase] = useState<Phase>({ kind: 'confirming' });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!token) {
      setPhase({ kind: 'failed', message: 'This link is incomplete. Copy the whole link from the email.' });
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    (async () => {
      try {
        const org = await apiPost<{ slug: string; organization: string; email: string }>('/bff/signup/verify', { token }, { skipAuth: true });
        setPhase({ kind: 'setting-up', ...org });
        const poll = async () => {
          if (stopped) return;
          try {
            const s = await apiGet<{ status: 'READY' | 'FAILED' | 'SETTING_UP' }>(`/bff/signup/status?token=${encodeURIComponent(token)}`, { skipAuth: true });
            if (s.status === 'READY') return setPhase({ kind: 'ready', ...org });
            if (s.status === 'FAILED') {
              return setPhase({ kind: 'failed', message: `Setting up ${org.organization} ran into a problem. The platform team has been told and will finish it; you'll get an email when it's ready.` });
            }
          } catch {
            // A blip: keep trying
          }
          timer = setTimeout(poll, 1500);
        };
        void poll();
      } catch (err) {
        setPhase({ kind: 'failed', message: err instanceof Error ? err.message : 'This link is invalid or has expired.' });
      }
    })();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [token]);

  if (phase.kind === 'failed') {
    return (
      <AuthCard title="Couldn't create the organization" subtitle={phase.message}>
        <div className="flex gap-4 text-sm font-medium">
          <Link to="/signup" className="text-blue-600 hover:text-blue-700">Sign up again</Link>
          <Link to="/login" className="text-blue-600 hover:text-blue-700">Go to sign in</Link>
        </div>
      </AuthCard>
    );
  }
  if (phase.kind === 'ready') {
    return (
      <AuthCard title={`${phase.organization} is ready`} subtitle={<>Sign in as <strong>{phase.email}</strong> with the password you chose.</>}>
        <div className="space-y-4">
          <p className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <CheckCircle2 size={18} className="text-green-600" aria-hidden />
            Your team signs in at <span className="font-mono">/{phase.slug}/login</span>
          </p>
          <Link to={`/${phase.slug}/login?email=${encodeURIComponent(phase.email)}`} className={`${authButtonClass} flex items-center justify-center`}>
            Sign in
          </Link>
        </div>
      </AuthCard>
    );
  }
  return (
    <AuthCard
      title={phase.kind === 'confirming' ? 'Confirming your email…' : `Setting up ${phase.organization}…`}
      subtitle={phase.kind === 'confirming' ? undefined : 'This usually takes a few seconds. You can leave this page; we will email you when it is ready.'}
    >
      <div role="status" className="flex items-center gap-3 text-sm text-slate-600 dark:text-slate-300">
        <span className="w-5 h-5 border-2 border-blue-600/30 border-t-blue-600 rounded-full animate-spin" aria-hidden />
        {phase.kind === 'confirming' ? 'Checking the link' : 'Creating the database and your administrator account'}
      </div>
    </AuthCard>
  );
}
