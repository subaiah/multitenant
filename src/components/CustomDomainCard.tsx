/**
 * The organization's own web address (Settings). Pending until the TXT record
 * that proves it is found; then the app, emails and sign-in use it.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, Check } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';
import { apiDelete, apiPost, apiPut } from '../lib/api-client';
import { Badge, Card, formatDateTime, inputClass, primaryButtonClass, secondaryButtonClass } from './ui';

interface DomainRecord { type: string; name: string; value: string; purpose: string }
interface DomainInfo {
  enabled: boolean;
  domain: string | null;
  status?: 'PENDING' | 'VERIFIED';
  verifiedAt?: string | null;
  checkedAt?: string | null;
  error?: string | null;
  records?: DomainRecord[];
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" aria-label={`Copy ${label}`} className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
      onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>
      {done ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

export function CustomDomainCard() {
  const { hasPermission } = useAuth();
  const info = useApi<DomainInfo>('/custom-domain');
  const canEdit = hasPermission('settings:manage');
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (what: string, call: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    try {
      await call();
      await info.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  };

  const d = info.data;
  if (!d || !d.enabled) return null;

  return (
    <Card title="Custom domain" description="Let your team reach the app at your own address, such as app.yourcompany.com.">
      {!d.domain ? (
        canEdit ? (
          <form className="flex flex-col sm:flex-row gap-2" onSubmit={(e) => { e.preventDefault(); void run('add', () => apiPut('/custom-domain', { domain })); }}>
            <label htmlFor="custom-domain" className="sr-only">Domain</label>
            <input id="custom-domain" className={`${inputClass} font-mono`} placeholder="app.yourcompany.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
            <button className={primaryButtonClass} disabled={!domain.trim() || !!busy}>{busy === 'add' ? 'Adding…' : 'Add domain'}</button>
          </form>
        ) : (
          <p className="text-sm text-slate-500">No custom domain. Tenant admins can add one.</p>
        )
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-slate-800 dark:text-white">{d.domain}</span>
            <Badge value={d.status ?? 'PENDING'} />
          </div>
          {d.status === 'VERIFIED' ? (
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Verified {formatDateTime(d.verifiedAt)}. Your team can sign in at <span className="font-mono">https://{d.domain}</span>, and emails link there.
              If you use single sign-on, add this domain's redirect URI to your identity provider (see <Link className="text-blue-600 hover:underline" to="/authentication">Sign-in methods</Link>).
            </p>
          ) : (
            <p className="text-sm text-slate-600 dark:text-slate-300">Add these records at your DNS provider, then check. The TXT record proves the domain is yours.</p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="py-1.5 pr-3 font-medium">Type</th><th className="py-1.5 pr-3 font-medium">Name</th><th className="py-1.5 font-medium">Value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                {d.records?.map((r) => (
                  <tr key={r.type} className="align-top">
                    <td className="py-2 pr-3 font-mono">{r.type}</td>
                    <td className="py-2 pr-3"><span className="font-mono break-all">{r.name}</span> <CopyButton text={r.name} label={`${r.type} name`} /></td>
                    <td className="py-2"><span className="font-mono break-all">{r.value}</span> <CopyButton text={r.value} label={`${r.type} value`} />
                      <p className="text-xs text-slate-500">{r.purpose}</p></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {d.status === 'VERIFIED' && d.error && (
            <p className="text-sm text-amber-700 dark:text-amber-400" role="status">
              The last check found a problem: {d.error} If it's still the case at the next daily check, the domain stops being used. Keep the CNAME (or the TXT record) in place.
            </p>
          )}
          {d.status !== 'VERIFIED' && d.error && (
            <p className="text-sm text-amber-700 dark:text-amber-400" role="status">{d.error} Last checked {formatDateTime(d.checkedAt)}.</p>
          )}
          {canEdit && (
            <div className="flex flex-wrap justify-end gap-2">
              <button className={secondaryButtonClass} disabled={!!busy}
                onClick={() => { if (window.confirm(`Stop using ${d.domain}? Your team signs in at the platform's address again.`)) void run('remove', () => apiDelete('/custom-domain')); }}>
                {busy === 'remove' ? 'Removing…' : 'Remove'}
              </button>
              {d.status !== 'VERIFIED' && (
                <button className={primaryButtonClass} disabled={!!busy} onClick={() => void run('check', () => apiPost('/custom-domain/check'))}>
                  {busy === 'check' ? 'Checking…' : 'Check now'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {error && <p className="text-sm text-red-600 mt-3" role="alert">{error}</p>}
    </Card>
  );
}
