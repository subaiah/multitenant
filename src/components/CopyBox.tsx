import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { secondaryButtonClass } from './ui';

/** A value to copy: a key or secret shown once, an address to paste elsewhere */
export function CopyBox({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-stretch gap-2">
      <code aria-label={label} className="flex-1 min-w-0 break-all rounded-md border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 px-3 py-2 text-xs font-mono text-slate-800 dark:text-slate-100">{value}</code>
      <button type="button" className={secondaryButtonClass} onClick={() => navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {})}>
        {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />} {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
