/**
 * What would break someone using API v1: comparing an earlier contract (the
 * OpenAPI document) with a newer one. Adding is fine; these aren't:
 *
 *   - a route (path and method) that's gone
 *   - a response field that's gone, or whose type changed
 *   - a request field, query parameter or response status that's gone
 *   - a request field or parameter that's newly required
 *   - an enum value that's gone (from a response or a request)
 */
type Json = Record<string, any>;

function resolve(doc: Json, s: Json | undefined): Json | undefined {
  if (!s) return s;
  if (typeof s.$ref === 'string') return resolve(doc, doc.components?.schemas?.[s.$ref.split('/').pop()!]);
  if (Array.isArray(s.allOf)) {
    const parts = s.allOf.map((p: Json) => resolve(doc, p) ?? {});
    return {
      type: 'object',
      properties: Object.assign({}, ...parts.map((p: Json) => p.properties ?? {})),
      required: parts.flatMap((p: Json) => p.required ?? []),
    };
  }
  return s;
}

const types = (s: Json | undefined) => [s?.type].flat().filter(Boolean).sort().join('|');

function compare(old: Json, neu: Json, oldS: Json | undefined, newS: Json | undefined, at: string, direction: 'response' | 'request', out: string[]) {
  const a = resolve(old, oldS);
  const b = resolve(neu, newS);
  if (!a) return;
  if (!b) {
    out.push(`${at}: gone`);
    return;
  }
  if (types(a) && types(b) && types(a) !== types(b)) {
    // A response may become non-nullable; a request may start accepting null
    const widened = direction === 'request' ? types(b).includes(types(a)) : types(a).includes(types(b));
    if (!widened) out.push(`${at}: type ${types(a)} became ${types(b)}`);
  }
  if (Array.isArray(a.enum)) {
    const missing = a.enum.filter((v: unknown) => !(b.enum ?? a.enum).includes(v));
    if (missing.length) out.push(`${at}: enum value(s) gone: ${missing.join(', ')}`);
  }
  if (a.items) compare(old, neu, a.items, b.items, `${at}[]`, direction, out);
  for (const [name, prop] of Object.entries(a.properties ?? {})) {
    const promised = direction === 'response' ? (a.required ?? []).includes(name) : true;
    if (!b.properties?.[name]) {
      if (promised) out.push(`${at}.${name}: gone`);
      continue;
    }
    if (direction === 'response' && promised && !(b.required ?? []).includes(name)) out.push(`${at}.${name}: no longer always present`);
    compare(old, neu, prop as Json, b.properties[name], `${at}.${name}`, direction, out);
  }
  if (direction === 'request') {
    for (const name of b.required ?? []) {
      if (!(a.required ?? []).includes(name)) out.push(`${at}.${name}: newly required`);
    }
  }
}

export function breakingChanges(old: Json, neu: Json): string[] {
  const out: string[] = [];
  for (const [path, ops] of Object.entries(old.paths ?? {})) {
    for (const [method, op] of Object.entries(ops as Json)) {
      const at = `${method.toUpperCase()} ${path}`;
      const n = (neu.paths?.[path] as Json | undefined)?.[method] as Json | undefined;
      if (!n) {
        out.push(`${at}: route gone`);
        continue;
      }
      const params = (o: Json) => new Map<string, Json>((o.parameters ?? []).map((p: Json) => [`${p.in}:${p.name}`, p]));
      const [pa, pb] = [params(op as Json), params(n)];
      for (const [key, p] of pa) {
        if (!pb.has(key)) out.push(`${at}: parameter ${key} gone`);
        else compare(old, neu, p.schema, pb.get(key)!.schema, `${at} ${key}`, 'request', out);
      }
      for (const [key, p] of pb) if (p.required && !pa.get(key)?.required) out.push(`${at}: parameter ${key} newly required`);
      const body = (o: Json) => o.requestBody?.content?.['application/json']?.schema;
      if (body(op as Json)) compare(old, neu, body(op as Json), body(n), `${at} body`, 'request', out);
      else if (body(n) && n.requestBody?.required && (resolve(neu, body(n))?.required ?? []).length) out.push(`${at}: newly requires a body`);
      for (const [status, r] of Object.entries((op as Json).responses ?? {})) {
        if (!Number(status) || Number(status) >= 400) continue;
        const nr = n.responses?.[status];
        if (!nr) {
          out.push(`${at}: response ${status} gone`);
          continue;
        }
        const schema = (x: Json) => x.content?.['application/json']?.schema;
        compare(old, neu, schema(r as Json), schema(nr), `${at} ${status}`, 'response', out);
      }
    }
  }
  return out;
}
