/**
 * When an invitation's email couldn't be sent: the invitation still exists, so
 * show its link for the inviter to pass on another way (and why the email failed).
 */
import { useState } from 'react';
import { AlertTriangle, Check, Copy, X } from 'lucide-react';

export interface InviteOutcome {
  invitationSent: boolean;
  inviteLink?: string;
  emailError?: string;
}

export function InviteLinkNotice({ email, outcome, onDismiss }: { email: string; outcome: InviteOutcome; onDismiss?: () => void }) {
  const [copied, setCopied] = useState(false);
  if (outcome.invitationSent || !outcome.inviteLink) return null;
  const copy = () => void navigator.clipboard?.writeText(outcome.inviteLink!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  return (
    <div role="status" className="p-4 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 text-sm space-y-2">
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className="shrink-0 mt-0.5 text-amber-600" aria-hidden />
        <div className="flex-1 min-w-0 text-amber-900 dark:text-amber-200">
          <p className="font-medium">The invitation for {email} is ready, but the email couldn't be sent.</p>
          {outcome.emailError && <p className="text-amber-800/90 dark:text-amber-300/90">{outcome.emailError}</p>}
          <p className="mt-1">Send them this link another way. Whoever opens it first sets the password, and it stops working when a new invitation is sent.</p>
        </div>
        {onDismiss && <button type="button" aria-label="Dismiss" onClick={onDismiss} className="p-1 text-amber-700 hover:text-amber-900"><X size={14} /></button>}
      </div>
      <div className="flex items-center gap-2">
        <input readOnly value={outcome.inviteLink} aria-label="Invitation link" onFocus={(e) => e.target.select()}
          className="flex-1 min-w-0 h-8 px-2 font-mono text-xs rounded-md border border-amber-200 dark:border-amber-500/30 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200" />
        <button type="button" onClick={copy} className="inline-flex items-center gap-1 h-8 px-3 rounded-md bg-white dark:bg-slate-800 border border-amber-200 dark:border-amber-500/30 text-xs font-medium text-amber-900 dark:text-amber-200">
          {copied ? <Check size={13} /> : <Copy size={13} />}{copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
    </div>
  );
}
