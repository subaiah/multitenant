/**
 * GET /internal/metrics: the Prometheus text format, with requests timed by
 * route pattern.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, startServer, stopServerAndCleanUp } from './helpers.js';

before(async () => {
  await startServer();
});

after(async () => {
  await stopServerAndCleanUp();
});

test('metrics are served as Prometheus text, and requests are counted by route pattern', async () => {
  assert.equal((await api('GET', '/health')).status, 200);
  assert.equal((await api('GET', '/users/00000000-0000-4000-8000-000000000000')).status, 401);

  // Not JSON: the helper hands the text back as it is
  const res = await api('GET', '/internal/metrics');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/plain/);
  const text = res.json as string;

  assert.match(text, /^# TYPE http_request_duration_seconds histogram$/m);
  assert.match(text, /http_request_duration_seconds_count\{method="GET",route="\/health\/?",status="200"\} [1-9]/);
  // The pattern, not the id that was asked for
  assert.match(text, /http_request_duration_seconds_count\{method="GET",route="\/users\/:id",status="401"\} [1-9]/);
  assert.ok(!text.includes('00000000-0000-4000-8000-000000000000'));
  assert.match(text, /^tenant_database_clients \d+$/m);
  assert.match(text, /^process_cpu_seconds_total /m);
  assert.match(text, /^# TYPE background_job_failures_total counter$/m);
});
