/**
 * Exporting the organization's data (Settings, administrators only): a ZIP of
 * CSV files, prepared in the background and kept for a few days.
 */
import { useEffect, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';
import { API_URL, apiGet, apiPost } from '../lib/api-client';
import { Badge, Card, formatDate, formatDateTime, primaryButtonClass } from './ui';

interface DataExport {
  id: string;
  status: 'PENDING' | 'RUNNING' | 'READY' | 'FAILED';
  requestedBy: string | null;
  createdAt: string;
  expiresAt: string | null;
  sizeBytes: number | null;
  tables: { table: string; rows: number }[] | null;
  error: string | null;
}

const size = (n: number | null) =>
  n === null ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

export function DataExportCard() {
  const { hasPermission } = useAuth();
  const list = useApi<{ canExport: boolean; exports: DataExport[] }>(hasPermission('settings:manage') ? '/data-exports' : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const working = list.data?.exports.some((e) => e.status === 'PENDING' || e.status === 'RUNNING');

  // Follow one that's being prepared
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => void list.reload(), 2000);
    return () => clearInterval(t);
  }, [working]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!list.data?.canExport) return null;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiPost('/data-exports');
      await list.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The export could not be started');
    } finally {
      setBusy(false);
    }
  };

  // A plain link, so the browser downloads the file itself; a quick call first renews the session if needed
  const download = async (id: string) => {
    await apiGet('/data-exports').catch(() => {});
    window.location.assign(`${API_URL}/data-exports/${id}/download`);
  };

  const now = Date.now();
  const shown = list.data.exports.filter((e) => e.status !== 'READY' || !e.expiresAt || new Date(e.expiresAt).getTime() > now);

  return (
    <div id="data-export">
      <Card
        title="Export data"
        description="Download everything your organization has stored here: a ZIP with one spreadsheet (CSV) per kind of record. Passwords and other secrets are left out."
        actions={
          <button className={`${primaryButtonClass} whitespace-nowrap`} onClick={start} disabled={busy || working}>
            {busy || working ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            {working ? 'Preparing…' : 'Export all data'}
          </button>
        }
      >
        {error && <p className="text-sm text-red-600 mb-3" role="alert">{error}</p>}
        {!shown.length ? (
          <p className="text-sm text-slate-500">No exports yet. Preparing one takes from a few seconds to a few minutes; you'll get an email when it's ready.</p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-700 text-sm">
            {shown.map((e) => (
              <li key={e.id} className="py-2.5 flex flex-wrap items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-slate-800 dark:text-white">{formatDateTime(e.createdAt)}{e.requestedBy && <span className="text-slate-500"> · {e.requestedBy}</span>}</p>
                  <p className="text-xs text-slate-500">
                    {e.status === 'READY'
                      ? `${size(e.sizeBytes)} · ${e.tables?.length ?? 0} tables · available until ${formatDate(e.expiresAt)}`
                      : e.status === 'FAILED' ? e.error : 'Being prepared; you will get an email when it is ready'}
                  </p>
                </div>
                {e.status === 'READY' ? (
                  <button className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-700 hover:text-blue-600 dark:text-blue-300" onClick={() => void download(e.id)}>
                    <Download size={14} />Download
                  </button>
                ) : (
                  <Badge value={e.status === 'RUNNING' ? 'PENDING' : e.status} />
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
