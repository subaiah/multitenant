import { ReactNode, useState } from 'react';
import { CheckCircle2, Circle, Eye, EyeOff, Lock } from 'lucide-react';
import { passwordRules, type PasswordPolicy } from '../lib/password-policy';

/** The frame of the public account pages (the same as the sign-in page). */
export function AuthCard({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 px-4 pt-16 sm:pt-24 pb-10">
      <div className="max-w-sm mx-auto">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-800 dark:text-white">{title}</h1>
        {subtitle && <p className="text-slate-600 dark:text-slate-400 mt-1">{subtitle}</p>}
        <div className="mt-7">{children}</div>
      </div>
    </div>
  );
}

export const authInputClass =
  'w-full h-10 px-3 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 text-slate-800 dark:text-slate-100';

export const authButtonClass =
  'w-full h-11 px-4 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-md disabled:opacity-50 disabled:cursor-not-allowed';

/** Password input with live policy checklist. Calls onValidChange when all rules pass. */
export function NewPasswordField({ value, onChange, policy, label = 'New password' }: { value: string; onChange: (v: string) => void; policy: PasswordPolicy; label?: string }) {
  const [show, setShow] = useState(false);
  const rules = passwordRules(policy);
  return (
    <div>
      <label htmlFor="new-password" className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1.5">{label}</label>
      <div className="relative">
        <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input id="new-password" type={show ? 'text' : 'password'} autoComplete="new-password" required value={value}
          onChange={(e) => onChange(e.target.value)} className={`${authInputClass} pl-9 pr-10`} />
        <button type="button" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600">
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
      <ul className="mt-2 space-y-1">
        {rules.map((r) => {
          const ok = r.test(value);
          return (
            <li key={r.label} className={`flex items-center gap-1.5 text-xs ${ok ? 'text-green-600 dark:text-green-400' : 'text-slate-500'}`}>
              {ok ? <CheckCircle2 size={13} /> : <Circle size={13} />} {r.label}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function meetsPolicy(password: string, policy: PasswordPolicy) {
  return passwordRules(policy).every((r) => r.test(password));
}
