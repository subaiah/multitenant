/**
 * Whether applications are up (docs/hub/HUB_GAPS.md G9).
 *
 * - An application gives a health address in its manifest (v2 health.url, on
 *   its own host). Every minute the platform asks it: 200 with
 *   { "status": "ok" | "degraded", "version": "…" } within 5 seconds.
 * - UP: answered ok in time. DEGRADED: it says so, or took over 2 seconds.
 *   DOWN: three checks in a row failed (no answer, an error, not 200), so one
 *   blip doesn't alarm anyone. Until then the last status stands, with the
 *   error shown to staff.
 * - Changes are recorded in the platform audit log. Staff see version,
 *   status, response time and the last error on the Integrations page.
 *   Organizations that have the application on see "having problems" next to
 *   it on Application Entitlements (no error details).
 */
import { controlDb } from './prisma.js';
import { recordAudit } from './audit.js';

export const TIMEOUT_MS = 5000;
export const SLOW_MS = 2000;
export const DOWN_AFTER = 3;
export type Health = 'UP' | 'DEGRADED' | 'DOWN';

let log: (msg: string, err?: unknown) => void = (msg, err) => console.error(msg, err);

/** Ask one application; record what it said, and audit a change */
export async function checkHealth(app: { id: string; key: string; name: string; healthUrl: string; healthStatus: string | null; healthFailures: number }) {
  const started = Date.now();
  let status: Health | null = null;
  let version: string | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(app.healthUrl, { headers: { accept: 'application/json', 'user-agent': 'Multitenant-Health/1' }, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = (await res.json().catch(() => null)) as { status?: unknown; version?: unknown } | null;
    if (res.status !== 200) error = `Answered ${res.status}`;
    else if (body?.status !== 'ok' && body?.status !== 'degraded') error = 'The answer has no "status": "ok" or "degraded"';
    else {
      status = body.status === 'degraded' || Date.now() - started > SLOW_MS ? 'DEGRADED' : 'UP';
      version = typeof body.version === 'string' ? body.version.slice(0, 50) : null;
    }
  } catch (err) {
    error = (err as Error).name === 'TimeoutError' ? `No answer within ${TIMEOUT_MS / 1000} seconds` : `Couldn't connect (${(err as Error).message})`;
  }
  const ms = Date.now() - started;
  const failures = status ? 0 : app.healthFailures + 1;
  const next: string | null = status ?? (failures >= DOWN_AFTER ? 'DOWN' : app.healthStatus);
  const changed = next !== app.healthStatus;
  await controlDb.applicationRegistry.update({
    where: { id: app.id },
    data: {
      healthStatus: next, healthResponseMs: status ? ms : null, healthCheckedAt: new Date(), healthError: error?.slice(0, 300) ?? null, healthFailures: failures,
      ...(version && { healthVersion: version }),
      ...(changed && { healthChangedAt: new Date() }),
    },
  });
  if (changed && next) {
    await recordAudit({ actor: { type: 'SYSTEM' } }, 'application.health_changed', {
      resource: { type: 'application', id: app.id, label: app.name },
      outcome: next === 'UP' ? 'SUCCESS' : 'FAILURE',
      details: { from: app.healthStatus, to: next, ...(error && { error }) },
    }).catch((err) => log('Recording a health change failed', err));
  }
  return { status: next, version, ms, error };
}

/** Every active application with a health address, a few at a time */
export async function checkAllHealth(): Promise<number> {
  const apps = await controlDb.applicationRegistry.findMany({
    where: { status: 'ACTIVE', healthUrl: { not: null } },
    select: { id: true, key: true, name: true, healthUrl: true, healthStatus: true, healthFailures: true },
  });
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, apps.length) }, async () => {
    while (next < apps.length) {
      const a = apps[next++];
      await checkHealth({ ...a, healthUrl: a.healthUrl! }).catch((err) => log(`Checking ${a.key}'s health failed`, err));
    }
  }));
  return apps.length;
}

let timer: NodeJS.Timeout | undefined;
let running = false;
export function startHealthChecks(logger: (msg: string, err?: unknown) => void) {
  log = logger;
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    void checkAllHealth().catch((err) => log('Checking applications failed', err)).finally(() => (running = false));
  }, 60_000);
  timer.unref();
}
export function stopHealthChecks() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
