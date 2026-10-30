/**
 * The background jobs, started together: by each API server (RUN_JOBS=true,
 * the default) or by a separate worker process (src/worker.ts) so that heavy
 * work, data exports above all, doesn't slow down requests.
 *
 * Every job is safe with several servers running it: each takes an advisory
 * lock or claims its rows, so one server does each piece of work.
 */
import { config } from '../config/env.js';
import { resumeProvisioning } from './provisioning.js';
import { startUsageRefresh, stopUsageRefresh } from './tenant-usage.js';
import { startTenantLifecycle, stopTenantLifecycle } from './tenant-lifecycle.js';
import { startAuditArchiving, stopAuditArchiving } from './audit.js';
import { notificationsSettled, startNotifications, stopNotifications } from './notifications.js';
import { startRateLimitCleanup, stopRateLimitCleanup } from './rate-limit-store.js';
import { controlDb } from './prisma.js';
import { runExport } from './data-export.js';
import { reportError } from './error-reporting.js';

export interface JobLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (err: unknown, msg: string) => void;
}

// --- Data exports ----------------------------------------------------------
// An API server with jobs on starts an export as soon as it's asked for. Any
// export still waiting (asked for on a server without jobs) is built here.

let exportTimer: NodeJS.Timeout | undefined;
let exportRun: Promise<void> | null = null;

export async function buildWaitingExports(): Promise<number> {
  const waiting = await controlDb.dataExport.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 5, select: { id: true } });
  for (const e of waiting) await runExport(e.id);
  return waiting.length;
}

function startExportPolling(log: JobLogger) {
  if (exportTimer || config.exportPollMs <= 0) return;
  exportTimer = setInterval(() => {
    if (exportRun) return; // one batch at a time per process
    exportRun = buildWaitingExports()
      .then(() => undefined)
      .catch((err) => log.error(err, 'Building data exports failed'))
      .finally(() => (exportRun = null));
  }, config.exportPollMs);
  exportTimer.unref();
}

// --- All of them -----------------------------------------------------------

export async function startJobs(log: JobLogger) {
  const failed = (msg: string, err?: unknown) => {
    log.error(err, msg);
    if (err) reportError(err, { job: msg });
  };
  // Finish provisioning interrupted by a restart
  await resumeProvisioning().catch((err) => failed('Resuming provisioning failed', err));
  startUsageRefresh((msg) => log.warn(msg), resumeProvisioning);
  startAuditArchiving(failed);
  startNotifications(failed);
  startRateLimitCleanup((err) => log.warn(`Removing expired rate-limit counters failed: ${(err as Error)?.message ?? err}`));
  startTenantLifecycle(failed);
  startExportPolling(log);
  log.info('Background jobs started');
}

export async function stopJobs() {
  stopUsageRefresh();
  stopAuditArchiving();
  stopNotifications();
  stopRateLimitCleanup();
  stopTenantLifecycle();
  if (exportTimer) clearInterval(exportTimer);
  exportTimer = undefined;
  // Let work in progress finish (a few seconds at most; an export that's cut
  // short is picked up again later)
  await Promise.race([notificationsSettled(), new Promise((r) => setTimeout(r, 5000))]);
}
