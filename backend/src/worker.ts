/**
 * The background jobs on their own (lib/jobs.ts), without serving the API:
 * run it next to API servers that have RUN_JOBS=false, so heavy work (data
 * exports above all) doesn't slow down requests.
 *
 *   node dist/worker.js          (the production image; the `worker` service
 *                                 in deploy/docker-compose.yml)
 *   npm run worker               (development)
 *
 * It answers GET /health on PORT, for the image's health check, and nothing
 * else. Several workers can run: each job takes a lock or claims its work.
 */
import { createServer } from 'node:http';
import { config } from './config/env.js';
import { controlDb, disconnectDatabases } from './lib/prisma.js';
import { pendingControlMigrations } from './lib/control-migrations.js';
import { startJobs, stopJobs } from './lib/jobs.js';
import { flushErrorReports, reportError } from './lib/error-reporting.js';

const levels = { info: 30, warn: 40, error: 50 } as const;
const write = (level: keyof typeof levels, msg: string, extra: Record<string, unknown> = {}) =>
  process.stdout.write(`${JSON.stringify({ level: levels[level], time: Date.now(), name: 'worker', msg, ...extra })}\n`);
const errorFields = (err: unknown) => (err instanceof Error ? { err: { type: err.name, message: err.message, stack: err.stack } } : err === undefined ? {} : { err: String(err) });

const health = createServer((req, res) => {
  const ok = req.method === 'GET' && req.url === '/health';
  res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' }).end(ok ? '{"status":"ok","role":"worker"}' : '{}');
});

async function main() {
  await controlDb.$connect();
  const pending = await pendingControlMigrations();
  if (pending.length) {
    const message = `The control-plane database is missing migrations: ${pending.join(', ')}. Run the migrate step first.`;
    if (config.nodeEnv === 'production') throw new Error(message);
    write('warn', message);
  }
  await new Promise<void>((resolve) => health.listen(config.port, config.host, resolve));
  await startJobs({
    info: (msg) => write('info', msg),
    warn: (msg) => write('warn', msg),
    error: (err, msg) => write('error', msg, errorFields(err)),
  });
}

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  write('info', 'Worker stopping');
  await stopJobs();
  await flushErrorReports();
  health.close();
  await disconnectDatabases();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch(async (err) => {
  write('error', 'Worker failed to start', errorFields(err));
  reportError(err, { job: 'worker start' });
  await flushErrorReports();
  process.exit(1);
});
