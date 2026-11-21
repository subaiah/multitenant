/**
 * Access rules (backend lib/access-rules.ts): a list, an editor and a "try
 * it" box, used for the platform's rules (Global policies) and an
 * organization's own (Access rules).
 */
import { useState } from 'react';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { Card, EmptyState, inputClass, primaryButtonClass, secondaryButtonClass } from './ui';

export interface Condition { attribute: string; op: string; value?: unknown }
export interface RuleBody {
  actions: string[];
  subjects?: { userTypes?: string[]; roles?: string[]; groups?: string[]; users?: string[] };
  when?: Condition[];
  timezone?: string;
}
export interface AccessRule {
  id: string;
  name: string;
  description?: string | null;
  effect: 'ALLOW' | 'DENY';
  priority: number;
  enabled: boolean;
  conditions: RuleBody | Record<string, unknown>;
}
export interface RuleInput { name: string; description: string | null; effect: 'ALLOW' | 'DENY'; priority: number; enabled: boolean; conditions: RuleBody }
export interface TryResult {
  decision: 'ALLOW' | 'DENY';
  deniedBy: { id: string; name: string; level: string } | null;
  evaluations: { ruleId: string; name: string; level: string; effect: string; matched: boolean; reason: string }[];
}

export const ATTRIBUTES: Record<string, string> = {
  'user.type': 'User type',
  'user.emailDomain': 'Email domain',
  'user.email': 'Email',
  'user.roles': 'Roles (names)',
  'user.groups': 'Groups (ids)',
  'user.units': 'Organizations / units (ids)',
  'user.id': 'User id',
  'context.ip': 'Address (IP)',
  'context.hour': 'Hour of day (0–23)',
  'context.weekday': 'Weekday (MON…SUN)',
  'context.date': 'Date (YYYY-MM-DD)',
  'context.apiKey': 'Is an API key (true/false)',
  'context.method': 'Method (GET, POST…)',
  'context.path': 'Address asked for',
  'resource.type': 'Resource type',
  'resource.id': 'Resource id',
};
const OPERATORS: Record<string, string> = {
  eq: 'is', neq: 'is not', in: 'is one of', notIn: 'is none of', contains: 'contains', notContains: "doesn't contain",
  between: 'is between', gte: 'is at least', lte: 'is at most', inCidr: 'is in range', notInCidr: 'is outside range',
  startsWith: 'starts with', endsWith: 'ends with', exists: 'is set', notExists: 'is not set',
};
const USER_TYPES = ['TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_DEVELOPER', 'TENANT_USER', 'TENANT_VIEWER', 'API_KEY'];
const LIST_OPS = new Set(['in', 'notIn', 'inCidr', 'notInCidr']);

const list = (text: string) => text.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
const bodyOf = (r: AccessRule): RuleBody | null => (Array.isArray((r.conditions as RuleBody).actions) ? (r.conditions as RuleBody) : null);

/** A condition's value as typed in the editor */
function valueText(c: Condition): string {
  if (c.value === undefined) return '';
  return Array.isArray(c.value) ? c.value.join(', ') : String(c.value);
}
function parseValue(op: string, attribute: string, text: string): unknown {
  if (op === 'exists' || op === 'notExists') return undefined;
  const numeric = attribute === 'context.hour';
  const conv = (t: string) => (numeric && /^\d+$/.test(t) ? Number(t) : t === 'true' ? true : t === 'false' ? false : t);
  if (op === 'between') return list(text).map(Number);
  if (op === 'gte' || op === 'lte') return Number(text);
  if (LIST_OPS.has(op)) return list(text).map(conv);
  return conv(text.trim());
}

/** In words, for the list */
export function describe(body: RuleBody | null): string {
  if (!body) return 'Saved in an older form: never applies. Edit it to make it a rule.';
  const parts = [`${body.actions.join(', ')}`];
  const s = body.subjects;
  if (s?.userTypes?.length) parts.push(`for ${s.userTypes.join(', ')}`);
  if (s?.roles?.length) parts.push(`holding ${s.roles.join(' or ')}`);
  if (s?.groups?.length) parts.push(`in ${s.groups.length} group(s)`);
  if (s?.users?.length) parts.push(`for ${s.users.length} person(s)`);
  for (const c of body.when ?? []) parts.push(`when ${ATTRIBUTES[c.attribute] ?? c.attribute} ${OPERATORS[c.op] ?? c.op}${c.value === undefined ? '' : ` ${valueText(c)}`}`);
  if (body.timezone && body.timezone !== 'UTC') parts.push(`(${body.timezone})`);
  return parts.join(' · ');
}

export function AccessRules({ title, description, rules, canManage, onSave, onDelete, onTry, tryNeedsOrganization }: {
  title: string;
  description: string;
  rules: AccessRule[];
  canManage: boolean;
  onSave: (input: RuleInput, id?: string) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  onTry: (input: { email: string; action: string; ip?: string; at?: string; tenantId?: string }) => Promise<TryResult>;
  /** The platform's rules are tried on someone in a chosen organization */
  tryNeedsOrganization?: { id: string; name: string }[];
}) {
  const [editing, setEditing] = useState<AccessRule | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <Card title={title} description={description}
      actions={canManage && <button className={primaryButtonClass} onClick={() => setEditing('new')}><Plus size={16} className="inline -mt-0.5 mr-1" />New rule</button>}>
      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      {rules.length === 0 ? (
        <EmptyState title="No rules" message="Roles alone decide. Add a rule to refuse something in some circumstances, such as outside working hours or the office network." />
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-700/50">
          {rules.map((r) => (
            <li key={r.id} className="py-3 flex items-start gap-3">
              <span className={`mt-0.5 px-2 py-0.5 rounded-md text-xs font-semibold ${r.effect === 'DENY' ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400' : 'bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-400'}`}>
                {r.effect === 'DENY' ? 'Refuse' : 'Allow'}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-800 dark:text-white">
                  {r.name} <span className="text-xs font-normal text-slate-500">priority {r.priority}{!r.enabled && ' · off'}</span>
                </p>
                <p className="text-xs text-slate-500 mt-0.5 break-words">{describe(bodyOf(r))}</p>
              </div>
              {canManage && (
                <div className="flex gap-1">
                  <button aria-label={`Edit ${r.name}`} className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700" onClick={() => setEditing(r)}><Pencil size={15} /></button>
                  <button aria-label={`Delete ${r.name}`} className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-red-600"
                    onClick={async () => {
                      if (!window.confirm(`Delete "${r.name}"?`)) return;
                      setError(null);
                      try { await onDelete(r.id); } catch (e) { setError(e instanceof Error ? e.message : 'Delete failed'); }
                    }}><Trash2 size={15} /></button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-slate-500 mt-3">
        Highest priority first; the first rule that matches decides. A refusal stops the request even when roles allow it; an allow rule is an exception to refusals below it. Rules never grant what roles don't.
      </p>
      <TryIt onTry={onTry} organizations={tryNeedsOrganization} />
      {editing && (
        <RuleEditor rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
          onSave={async (input) => { await onSave(input, editing === 'new' ? undefined : editing.id); setEditing(null); }} />
      )}
    </Card>
  );
}

function RuleEditor({ rule, onClose, onSave }: { rule: AccessRule | null; onClose: () => void; onSave: (input: RuleInput) => Promise<void> }) {
  const body = rule ? bodyOf(rule) : null;
  const [form, setForm] = useState({
    name: rule?.name ?? '',
    description: rule?.description ?? '',
    effect: rule?.effect ?? ('DENY' as const),
    priority: rule?.priority ?? 0,
    enabled: rule?.enabled ?? true,
    actions: body?.actions.join(', ') ?? '',
    userTypes: body?.subjects?.userTypes ?? [],
    roles: body?.subjects?.roles?.join(', ') ?? '',
    users: body?.subjects?.users?.join(', ') ?? '',
    timezone: body?.timezone ?? 'UTC',
    when: (body?.when ?? []).map((c) => ({ attribute: c.attribute, op: c.op, value: valueText(c) })),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const subjects = {
        ...(form.userTypes.length && { userTypes: form.userTypes }),
        ...(list(form.roles).length && { roles: list(form.roles) }),
        ...(list(form.users).length && { users: list(form.users) }),
      };
      await onSave({
        name: form.name,
        description: form.description || null,
        effect: form.effect,
        priority: Number(form.priority),
        enabled: form.enabled,
        conditions: {
          actions: list(form.actions),
          ...(Object.keys(subjects).length && { subjects }),
          ...(form.when.length && { when: form.when.map((c) => ({ attribute: c.attribute, op: c.op, ...(parseValue(c.op, c.attribute, c.value) !== undefined && { value: parseValue(c.op, c.attribute, c.value) }) })) }),
          ...(form.timezone && form.timezone !== 'UTC' && { timezone: form.timezone }),
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const label = 'block text-sm font-medium text-slate-700 dark:text-slate-200';
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onClick={onClose}>
      <aside role="dialog" aria-label={rule ? 'Edit access rule' : 'New access rule'} onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl h-full overflow-y-auto bg-white dark:bg-slate-800 p-6 shadow-xl space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-800 dark:text-white">{rule ? 'Edit access rule' : 'New access rule'}</h3>
          <button onClick={onClose} aria-label="Close" className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700"><X size={18} /></button>
        </div>
        <label className={label}>Name<input className={`${inputClass} mt-1`} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <div className="grid grid-cols-3 gap-3">
          <label className={label}>Effect
            <select className={`${inputClass} mt-1`} value={form.effect} onChange={(e) => setForm({ ...form, effect: e.target.value as 'ALLOW' | 'DENY' })}>
              <option value="DENY">Refuse</option>
              <option value="ALLOW">Allow (exception)</option>
            </select>
          </label>
          <label className={label}>Priority<input type="number" min={0} className={`${inputClass} mt-1`} value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} /></label>
          <label className="flex items-center gap-2 text-sm mt-6"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />On</label>
        </div>
        <label className={label}>Permissions it covers
          <input className={`${inputClass} mt-1 font-mono`} placeholder="users:delete, billing:*" value={form.actions} onChange={(e) => setForm({ ...form, actions: e.target.value })} />
          <span className="block text-xs text-slate-500 mt-1 font-normal">Comma-separated; * for every permission.</span>
        </label>
        <fieldset>
          <legend className={label}>Who it's about <span className="font-normal text-xs text-slate-500">(none chosen: everyone)</span></legend>
          <div className="flex flex-wrap gap-3 mt-1">
            {USER_TYPES.map((t) => (
              <label key={t} className="flex items-center gap-1.5 text-xs">
                <input type="checkbox" checked={form.userTypes.includes(t)}
                  onChange={(e) => setForm({ ...form, userTypes: e.target.checked ? [...form.userTypes, t] : form.userTypes.filter((x) => x !== t) })} />
                {t.replace('TENANT_', '').replace('_', ' ').toLowerCase()}
              </label>
            ))}
          </div>
          <input className={`${inputClass} mt-2`} placeholder="Role names, comma-separated" value={form.roles} onChange={(e) => setForm({ ...form, roles: e.target.value })} />
          <input className={`${inputClass} mt-2 font-mono`} placeholder="User ids, comma-separated" value={form.users} onChange={(e) => setForm({ ...form, users: e.target.value })} />
        </fieldset>
        <fieldset>
          <legend className={label}>When <span className="font-normal text-xs text-slate-500">(all must hold)</span></legend>
          {form.when.map((c, i) => (
            <div key={i} className="flex gap-2 mt-2">
              <select aria-label="Attribute" className={inputClass} value={c.attribute}
                onChange={(e) => setForm({ ...form, when: form.when.map((x, j) => (j === i ? { ...x, attribute: e.target.value } : x)) })}>
                {Object.entries(ATTRIBUTES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <select aria-label="Operator" className={inputClass} value={c.op}
                onChange={(e) => setForm({ ...form, when: form.when.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)) })}>
                {Object.entries(OPERATORS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              {c.op !== 'exists' && c.op !== 'notExists' && (
                <input aria-label="Value" className={inputClass} value={c.value}
                  placeholder={c.op === 'between' ? '9, 18' : LIST_OPS.has(c.op) ? 'a, b' : 'value'}
                  onChange={(e) => setForm({ ...form, when: form.when.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
              )}
              <button aria-label="Remove condition" className="p-2 text-slate-500" onClick={() => setForm({ ...form, when: form.when.filter((_, j) => j !== i) })}><X size={15} /></button>
            </div>
          ))}
          <button className="mt-2 text-sm text-blue-600" onClick={() => setForm({ ...form, when: [...form.when, { attribute: 'context.hour', op: 'between', value: '' }] })}>+ Add a condition</button>
        </fieldset>
        <label className={label}>Time zone for the hour, weekday and date
          <input className={`${inputClass} mt-1`} placeholder="UTC" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
        </label>
        <label className={label}>Description<textarea rows={2} className={`${inputClass} mt-1`} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button className={secondaryButtonClass} onClick={onClose}>Cancel</button>
          <button className={primaryButtonClass} disabled={saving || !form.name || !list(form.actions).length} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </aside>
    </div>
  );
}

function TryIt({ onTry, organizations }: { onTry: Parameters<typeof AccessRules>[0]['onTry']; organizations?: { id: string; name: string }[] }) {
  const [form, setForm] = useState({ tenantId: organizations?.[0]?.id ?? '', email: '', action: '', ip: '', at: '' });
  const [result, setResult] = useState<TryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setError(null);
    setResult(null);
    try {
      setResult(await onTry({
        email: form.email, action: form.action,
        ...(form.ip && { ip: form.ip }),
        ...(form.at && { at: new Date(form.at).toISOString() }),
        ...(organizations && { tenantId: form.tenantId }),
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not try it');
    }
  };
  return (
    <details className="mt-4 rounded-lg bg-slate-50 dark:bg-slate-900 p-3">
      <summary className="text-sm font-medium cursor-pointer text-slate-700 dark:text-slate-200">Try it</summary>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-3">
        {organizations && (
          <select aria-label="Organization" className={inputClass} value={form.tenantId} onChange={(e) => setForm({ ...form, tenantId: e.target.value })}>
            {organizations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        )}
        <input aria-label="Email" className={inputClass} placeholder="Their email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <input aria-label="Permission" className={`${inputClass} font-mono`} placeholder="Permission, e.g. users:delete" value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })} />
        <input aria-label="From address" className={inputClass} placeholder="From address (optional)" value={form.ip} onChange={(e) => setForm({ ...form, ip: e.target.value })} />
        <input aria-label="When" type="datetime-local" className={inputClass} value={form.at} onChange={(e) => setForm({ ...form, at: e.target.value })} />
      </div>
      <button className={`${secondaryButtonClass} mt-2`} disabled={!form.email || !form.action} onClick={run}>Try</button>
      {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
      {result && (
        <div className="mt-3 text-sm">
          <p className={`font-semibold ${result.decision === 'DENY' ? 'text-red-600' : 'text-green-600'}`}>
            {result.decision === 'DENY' ? `Refused by "${result.deniedBy?.name}"` : 'Allowed by the rules'}{result.decision === 'ALLOW' && <span className="font-normal text-slate-500"> (their roles must allow it too)</span>}
          </p>
          <ul className="mt-2 space-y-1 text-xs">
            {result.evaluations.map((e) => (
              <li key={e.ruleId} className={e.matched ? 'text-slate-800 dark:text-white' : 'text-slate-500'}>
                {e.matched ? '●' : '○'} <span className="font-medium">{e.name}</span> ({e.level === 'platform' ? 'platform' : 'organization'}, {e.effect === 'DENY' ? 'refuse' : 'allow'}): {e.reason}
              </li>
            ))}
            {result.evaluations.length === 0 && <li className="text-slate-500">No rules apply.</li>}
          </ul>
        </div>
      )}
    </details>
  );
}
