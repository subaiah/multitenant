/**
 * Two-factor sign-in pieces: the step after the password on the sign-in page
 * (enter a code, or set up an authenticator when the organization requires
 * it), and the parts the Profile page reuses (QR code, recovery codes).
 */
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { ArrowRight, Copy, Download, KeyRound, ShieldCheck } from 'lucide-react';
import { apiPost, type MfaStep } from '../lib/api-client';

export interface Enrollment {
  secret: string;
  otpauthUrl: string;
  enrollToken: string;
}

export function QrCode({ text, size = 180 }: { text: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(text, { width: size, margin: 1 }).then((url) => live && setSrc(url)).catch(() => setSrc(null));
    return () => {
      live = false;
    };
  }, [text, size]);
  return src ? (
    <img src={src} width={size} height={size} alt="QR code for your authenticator app" className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white" />
  ) : (
    <div style={{ width: size, height: size }} className="rounded-lg bg-slate-100 dark:bg-slate-700" />
  );
}

/** The secret spaced in groups of four, for typing into an app by hand. */
const grouped = (secret: string) => secret.replace(/(.{4})/g, '$1 ').trim();

export function CodeField({ value, onChange, allowRecovery = false, autoFocus = true }: {
  value: string;
  onChange: (v: string) => void;
  allowRecovery?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <input
      type="text"
      inputMode={allowRecovery ? 'text' : 'numeric'}
      autoComplete="one-time-code"
      autoFocus={autoFocus}
      value={value}
      onChange={(e) => onChange(allowRecovery ? e.target.value.slice(0, 20) : e.target.value.replace(/\D/g, '').slice(0, 6))}
      required
      aria-label={allowRecovery ? 'Authentication code or recovery code' : 'Authentication code'}
      className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-slate-700 dark:text-slate-200 text-center text-2xl font-mono tracking-widest"
      placeholder="000000"
    />
  );
}

/** Scan or type the secret; shown during sign-in and on the Profile page. */
export function EnrollInstructions({ enrollment }: { enrollment: Enrollment }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Scan this with an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password and the like), then enter the 6-digit code it shows.
      </p>
      <div className="flex justify-center">
        <QrCode text={enrollment.otpauthUrl} />
      </div>
      <details className="text-xs text-slate-500 dark:text-slate-400">
        <summary className="cursor-pointer">Can't scan? Enter this key instead</summary>
        <code className="block mt-2 p-2 rounded bg-slate-100 dark:bg-slate-900 font-mono text-sm break-all select-all">{grouped(enrollment.secret)}</code>
      </details>
    </div>
  );
}

export function RecoveryCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);
  const text = codes.join('\n');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      /* clipboard not allowed: the codes are on screen */
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Keep these recovery codes somewhere safe. Each one signs you in once if you lose your device. They won't be shown again.
      </p>
      <ul className="grid grid-cols-2 gap-2 p-3 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 font-mono text-sm text-slate-700 dark:text-slate-200" aria-label="Recovery codes">
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ul>
      <div className="flex gap-2">
        <button type="button" onClick={copy} className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-lg bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200">
          <Copy size={14} /> {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" onClick={download} className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-lg bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200">
          <Download size={14} /> Download
        </button>
      </div>
    </div>
  );
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong');

/**
 * The step after a correct password or emailed code. Calls onSignedIn once
 * the session exists (after recovery codes are acknowledged, when new).
 */
export function TwoFactorSignIn({ step, primaryColor, onSignedIn, onCancel }: {
  step: MfaStep;
  primaryColor: string;
  onSignedIn: () => void;
  onCancel: () => void;
}) {
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);

  useEffect(() => {
    if (step.mfa !== 'enroll') return;
    apiPost<Enrollment>('/bff/auth/mfa/enroll/start', { mfaToken: step.mfaToken }, { skipAuth: true })
      .then(setEnrollment)
      .catch((err) => setError(messageOf(err)));
  }, [step]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (step.mfa === 'verify') {
        const res = await apiPost<{ recoveryCodesLeft?: number }>('/bff/auth/mfa/verify', { mfaToken: step.mfaToken, code }, { skipAuth: true });
        if (res.recoveryCodesLeft !== undefined && res.recoveryCodesLeft <= 3) {
          setNotice(`You have ${res.recoveryCodesLeft} recovery code${res.recoveryCodesLeft === 1 ? '' : 's'} left. Make new ones from your profile.`);
          setTimeout(onSignedIn, 2500);
          return;
        }
        onSignedIn();
      } else if (enrollment) {
        const res = await apiPost<{ recoveryCodes: string[] }>('/bff/auth/mfa/enroll/confirm', { enrollToken: enrollment.enrollToken, code }, { skipAuth: true });
        setRecoveryCodes(res.recoveryCodes);
      }
    } catch (err) {
      setError(messageOf(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const errorBox = error && (
    <p role="alert" className="p-3 text-sm rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 text-red-800 dark:text-red-300">{error}</p>
  );
  const button = (label: string, disabled: boolean) => (
    <button
      type="submit"
      disabled={disabled}
      className="w-full flex items-center justify-center gap-2 px-6 py-3 text-white font-medium rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm hover:shadow-md"
      style={{ backgroundColor: primaryColor }}
    >
      {busy ? <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white" /> : <><span>{label}</span><ArrowRight size={16} /></>}
    </button>
  );
  const back = (
    <button type="button" onClick={onCancel} className="w-full text-sm text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200">
      ← Start again
    </button>
  );

  if (recoveryCodes) {
    return (
      <div className="space-y-4">
        <h2 className="flex items-center gap-2 font-semibold text-slate-800 dark:text-white"><ShieldCheck size={18} className="text-green-600" /> Two-factor is set up</h2>
        <RecoveryCodes codes={recoveryCodes} />
        <form onSubmit={(e) => { e.preventDefault(); onSignedIn(); }}>{button("I've saved them — continue", false)}</form>
      </div>
    );
  }

  if (notice) {
    return <p role="status" className="p-3 text-sm rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 text-amber-800 dark:text-amber-300">{notice}</p>;
  }

  if (step.mfa === 'enroll') {
    return (
      <form onSubmit={submit} className="space-y-4">
        <h2 className="flex items-center gap-2 font-semibold text-slate-800 dark:text-white"><KeyRound size={18} /> Set up two-factor sign-in</h2>
        <p className="text-sm text-slate-600 dark:text-slate-400">Your organization requires a second step when you sign in.</p>
        {errorBox}
        {enrollment ? <EnrollInstructions enrollment={enrollment} /> : !error && <div className="h-48 rounded-lg bg-slate-100 dark:bg-slate-700 animate-pulse" />}
        {enrollment && <CodeField value={code} onChange={setCode} />}
        {enrollment && button('Confirm and sign in', busy || code.length !== 6)}
        {back}
      </form>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <h2 className="flex items-center gap-2 font-semibold text-slate-800 dark:text-white"><KeyRound size={18} /> Two-factor sign-in</h2>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        {useRecovery ? 'Enter one of your recovery codes.' : 'Enter the 6-digit code from your authenticator app.'}
      </p>
      {errorBox}
      <CodeField value={code} onChange={setCode} allowRecovery={useRecovery} />
      {button('Verify and sign in', busy || (useRecovery ? code.trim().length < 10 : code.length !== 6))}
      <button
        type="button"
        onClick={() => { setUseRecovery(!useRecovery); setCode(''); setError(null); }}
        className="w-full text-sm text-blue-600 hover:text-blue-700"
      >
        {useRecovery ? 'Use my authenticator app' : 'Lost your device? Use a recovery code'}
      </button>
      {back}
    </form>
  );
}
