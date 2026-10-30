/**
 * Running it: background jobs in a separate worker (src/worker.ts, RUN_JOBS),
 * and error tracking (lib/error-reporting.ts) against a stand-in for Sentry.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { api as mainApi, db, loginSession, seedTenant, startExtraServer, startServer, stopServerAndCleanUp, type TenantSeed } from './helpers.js';
import { framesOf, parseDsn } from '../src/lib/error-reporting.js';

let A: TenantSeed;
let sentry: Server;
let dsn: string;
const received: { url: string; auth: string; header: any; item: any; event: any }[] = [];

before(async () => {
  // A stand-in for Sentry's ingest endpoint: keeps every envelope it gets
  sentry = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const [header, item, event] = body.trim().split('\n').map((l) => JSON.parse(l));
      received.push({ url: req.url ?? '', auth: String(req.headers['x-sentry-auth'] ?? ''), header, item, event });
      res.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((r) => sentry.listen(0, '127.0.0.1', r));
  dsn = `http://publickey123@127.0.0.1:${(sentry.address() as AddressInfo).port}/42`;
  A = await seedTenant('ops');
  await startServer();
});
after(async () => {
  sentry.close();
  await stopServerAndCleanUp();
});

const eventually = async <T>(what: string, check: () => Promise<T | undefined> | T | undefined, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
    const v = await check();
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
};

function spawnWorker(env: Record<string, string>) {
  return spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts'], {
    env: { ...process.env, LOG_LEVEL: 'error', HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}
const exited = (child: ChildProcess) => new Promise<number | null>((r) => child.once('exit', (code) => r(code)));

test('an API server with RUN_JOBS=false leaves exports to the worker, which builds them', async () => {
  const api = await startExtraServer({ RUN_JOBS: 'false' });
  const { controlDb } = await db();
  let worker: ChildProcess | undefined;
  try {
    const { cookie } = await loginSession(A.slug, A.adminEmail);
    const started = await api.api('POST', '/data-exports', { cookie });
    assert.equal(started.status, 202, JSON.stringify(started.json));
    const id = started.json.id ?? started.json.export?.id;
    assert.ok(id, JSON.stringify(started.json));
    await sleep(1500);
    assert.equal((await controlDb.dataExport.findUniqueOrThrow({ where: { id } })).status, 'PENDING', 'nothing on that server builds it');

    const port = String(40000 + Math.floor(Math.random() * 20000));
    worker = spawnWorker({ PORT: port, EXPORT_POLL_MS: '300' });
    await eventually('the worker to answer its health check', async () => (await fetch(`http://127.0.0.1:${port}/health`).catch(() => null))?.ok);
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/health`)).json(), { status: 'ok', role: 'worker' });
    assert.equal((await fetch(`http://127.0.0.1:${port}/tenants`)).status, 404, 'the worker serves no API');

    const done = await eventually('the export', async () => {
      const e = await controlDb.dataExport.findUniqueOrThrow({ where: { id } });
      return e.status === 'READY' || e.status === 'FAILED' ? e : undefined;
    }, 30_000);
    assert.equal(done.status, 'READY', done.error ?? '');

    // Stops cleanly when told to
    const code = exited(worker);
    worker.kill('SIGTERM');
    assert.equal(await code, 0);
    worker = undefined;
  } finally {
    worker?.kill('SIGKILL');
    await api.stop();
  }
});

test("errors in people's browsers go to error tracking, with nothing private", async () => {
  const api = await startExtraServer({ SENTRY_FRONTEND_DSN: dsn, SENTRY_ENVIRONMENT: 'test', APP_VERSION: 'abc123' });
  try {
    const before = received.length;
    const stack = 'TypeError: x is undefined\n    at render (http://localhost:5173/assets/index-abc.js:10:20)\n    at http://localhost:5173/assets/vendor.js:1:2';
    const res = await api.api('POST', '/bff/errors', { body: { message: 'x is undefined', type: 'TypeError', stack, path: '/users' }, headers: { cookie: 'access_token=secret-token' } });
    assert.equal(res.status, 204);
    const got = await eventually('the event', () => received.slice(before).find((r) => r.event?.exception?.values?.[0]?.value === 'x is undefined'));
    assert.equal(got.url, '/api/42/envelope/');
    assert.match(got.auth, /sentry_key=publickey123/);
    assert.equal(got.item.type, 'event');
    assert.equal(got.event.platform, 'javascript');
    assert.equal(got.event.environment, 'test');
    assert.equal(got.event.release, 'abc123');
    assert.equal(got.event.tags.path, '/users');
    assert.equal(got.event.exception.values[0].type, 'TypeError');
    assert.deepEqual(got.event.exception.values[0].stacktrace.frames.map((f: any) => f.lineno), [1, 10], 'oldest call first');
    assert.doesNotMatch(JSON.stringify(got), /secret-token|cookie/i);

    // A path with a query string (which can hold tokens) is refused, silently
    const quiet = received.length;
    assert.equal((await api.api('POST', '/bff/errors', { body: { message: 'leak', path: '/reset?token=abc' } })).status, 204);
    await sleep(500);
    assert.equal(received.slice(quiet).filter((r) => r.event?.exception?.values?.[0]?.value === 'leak').length, 0);
  } finally {
    await api.stop();
  }
});

test('without a DSN, browser errors are accepted and dropped', async () => {
  // The main test server has no SENTRY_FRONTEND_DSN
  const before = received.length;
  assert.equal((await mainApi('POST', '/bff/errors', { body: { message: 'nobody listens' } })).status, 204);
  await sleep(300);
  assert.equal(received.length, before);
});

test('server errors are reported: a worker that cannot start', async () => {
  const before = received.length;
  const worker = spawnWorker({ PORT: '0', SENTRY_DSN: dsn, DATABASE_URL: 'postgresql://nobody:wrong@127.0.0.1:1/nothing' });
  assert.equal(await exited(worker), 1);
  const got = await eventually('the event', () => received.slice(before).find((r) => r.event?.tags?.job === 'worker start'));
  assert.equal(got.event.platform, 'node');
  assert.equal(got.event.level, 'error');
  assert.ok(got.event.exception.values[0].stacktrace.frames.length > 0);
});

test('DSNs and stack traces are read correctly', () => {
  assert.deepEqual(parseDsn('https://abc@o123.ingest.us.sentry.io/4507'), { url: 'https://o123.ingest.us.sentry.io/api/4507/envelope/', dsn: 'https://abc@o123.ingest.us.sentry.io/4507', key: 'abc' });
  assert.equal(parseDsn('https://glitchtip.example.com/sub/7')?.url, undefined, 'no key: not a DSN');
  assert.equal(parseDsn('https://k@glitchtip.example.com/sub/7')?.url, 'https://glitchtip.example.com/sub/api/7/envelope/');
  assert.equal(parseDsn('not a url'), null);

  const frames = framesOf('Error: boom\n    at inner (/app/dist/lib/x.js:5:7)\n    at async outer (/app/node_modules/fastify/lib/route.js:9:1)\n    at /app/dist/server.js:1:2');
  assert.deepEqual(frames.map((f) => [f.function, f.lineno, f.in_app]), [[undefined, 1, true], ['async outer', 9, false], ['inner', 5, true]]);
  const firefox = framesOf('Error: boom\nrender@http://localhost/assets/a.js:3:4\n@http://localhost/assets/b.js:1:1');
  assert.deepEqual(firefox.map((f) => f.lineno), [1, 3]);
});
