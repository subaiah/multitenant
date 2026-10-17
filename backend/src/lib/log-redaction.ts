/**
 * What the request log says about each request. Fastify's default logs the
 * whole URL, and a few URLs carry secrets: invitation and password-reset
 * tokens (in the path) and single sign-on codes (in the query). Logs are read
 * by more people, and kept longer, than those links should be.
 */
import type { FastifyRequest } from 'fastify';

/** Path segments that are secrets: the one after each of these */
const SECRET_AFTER = ['/invitations/', '/password/reset/'];
/** Query parameters that are secrets */
const SECRET_PARAMS = ['token', 'code', 'state', 'id_token', 'access_token', 'refresh_token', 'session_state'];

export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  let path = q < 0 ? url : url.slice(0, q);
  for (const marker of SECRET_AFTER) {
    const i = path.indexOf(marker);
    // ".../invitations/accept" is an action, not a token
    if (i >= 0 && !/^(accept)?$/.test(path.slice(i + marker.length))) path = `${path.slice(0, i + marker.length)}[redacted]`;
  }
  if (q < 0) return path;
  const params = new URLSearchParams(url.slice(q + 1));
  for (const name of SECRET_PARAMS) if (params.has(name)) params.set(name, '[redacted]');
  return `${path}?${params.toString().replaceAll('%5Bredacted%5D', '[redacted]')}`;
}

export function serializeRequest(request: FastifyRequest) {
  return {
    method: request.method,
    url: redactUrl(request.url),
    host: request.host,
    remoteAddress: request.ip,
  };
}
