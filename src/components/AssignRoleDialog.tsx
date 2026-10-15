import { useState } from 'react';
import { User as UserIcon, Users as UsersIcon } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';
import { apiPost } from '../lib/api-client';
import { rolePermissions, type Role, type Scopes } from '../lib/access';
import { Dialog, Field } from './Dialog';
import { inputClass, primaryButtonClass, secondaryButtonClass } from './ui';

export interface Principal {
  type: 'USER' | 'GROUP';
  id: string;
  name: string;
}

interface Option { id: string; label: string; detail?: string }

/**
 * Assign a role to a user or group. Pass `principal` to fix who receives it
 * (e.g. from a group's page); otherwise the dialog lets you pick.
 */
export function AssignRoleDialog({ principal, onClose, onAssigned }: {
  principal?: Principal;
  onClose: () => void;
  onAssigned: (message: string) => void | Promise<void>;
}) {
  const { hasPermission } = useAuth();
  const roles = useApi<{ roles: Role[] }>('/roles');
  const scopes = useApi<Scopes>('/roles/scopes');

  const [type, setType] = useState<'USER' | 'GROUP'>(principal?.type ?? 'USER');
  const [query, setQuery] = useState('');
  const [principalId, setPrincipalId] = useState(principal?.id ?? '');
  const [roleId, setRoleId] = useState('');
  const [scope, setScope] = useState('TENANT');
  const [validFrom, setValidFrom] = useState('');
  const [validTo, setValidTo] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const q = encodeURIComponent(query.trim());
  const users = useApi<{ data: { id: string; name: string | null; email: string; status: string }[] }>(
    principal || type !== 'USER' ? null : `/users?limit=50${q ? `&search=${q}` : ''}`,
  );
  const groups = useApi<{ groups: { id: string; name: string; status: string; _count: { members: number } }[] }>(
    principal || type !== 'GROUP' ? null : `/groups?limit=50${q ? `&search=${q}` : ''}`,
  );
  const options: Option[] = type === 'USER'
    ? (users.data?.data ?? []).map((u) => ({ id: u.id, label: u.name || u.email, detail: u.status === 'ACTIVE' ? u.email : `${u.email} · ${u.status.toLowerCase()}` }))
    : (groups.data?.groups ?? []).map((g) => ({ id: g.id, label: g.name, detail: `${g._count.members} ${g._count.members === 1 ? 'member' : 'members'}${g.status !== 'ACTIVE' ? ' · inactive' : ''}` }));

  const role = roles.data?.roles.find((r) => r.id === roleId);
  const beyondMe = (r: Role) => rolePermissions(r).some((p) => !hasPermission(p));

  const [scopeType, scopeId] = scope.includes(':') ? (scope.split(':') as [string, string]) : [scope, undefined];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!principalId || !role) return;
    setSaving(true);
    setError(null);
    try {
      await apiPost('/roles/assign', {
        roleId,
        principalType: type,
        ...(type === 'USER' ? { userId: principalId } : { groupId: principalId }),
        scopeType,
        ...(scopeId && { scopeId }),
        ...(validFrom && { validFrom: new Date(`${validFrom}T00:00:00`).toISOString() }),
        ...(validTo && { validTo: new Date(`${validTo}T23:59:59`).toISOString() }),
      });
      const who = principal?.name ?? options.find((o) => o.id === principalId)?.label ?? 'them';
      await onAssigned(`${role.name} assigned to ${who}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not assign the role');
      setSaving(false);
    }
  };

  const datesInvalid = !!validFrom && !!validTo && validTo < validFrom;

  return (
    <Dialog title={principal ? `Assign a role to ${principal.name}` : 'Assign role'} onClose={onClose} onSubmit={submit} wide>
      {!principal && (
        <>
          <div role="radiogroup" aria-label="Assign to" className="grid grid-cols-2 gap-2">
            {(['USER', 'GROUP'] as const).map((t) => (
              <button key={t} type="button" role="radio" aria-checked={type === t}
                onClick={() => { setType(t); setPrincipalId(''); setQuery(''); }}
                className={`flex items-center justify-center gap-2 py-2 text-sm rounded-lg border ${type === t
                  ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300'
                  : 'border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300'}`}>
                {t === 'USER' ? <UserIcon size={16} /> : <UsersIcon size={16} />}{t === 'USER' ? 'A person' : 'A group'}
              </button>
            ))}
          </div>
          <Field label={type === 'USER' ? 'Person' : 'Group'}>
            <input aria-label={type === 'USER' ? 'Search people' : 'Search groups'} placeholder={type === 'USER' ? 'Search by name or email' : 'Search groups'}
              value={query} onChange={(e) => setQuery(e.target.value)} className={inputClass} />
            <select aria-label={type === 'USER' ? 'Person' : 'Group'} required size={Math.min(5, Math.max(2, options.length))} value={principalId}
              onChange={(e) => setPrincipalId(e.target.value)} className={`${inputClass} mt-2`}>
              {options.map((o) => <option key={o.id} value={o.id}>{o.label}{o.detail ? ` — ${o.detail}` : ''}</option>)}
            </select>
            {options.length === 0 && !users.loading && !groups.loading && <span className="block mt-1 text-xs text-slate-500">No matches</span>}
          </Field>
        </>
      )}

      <Field label="Role" hint={role && (
        <>{role.description ? `${role.description}. ` : ''}{rolePermissions(role).length} permissions: {rolePermissions(role).slice(0, 6).join(', ')}{rolePermissions(role).length > 6 ? ', …' : ''}</>
      )}>
        <select aria-label="Role" required value={roleId} onChange={(e) => setRoleId(e.target.value)} className={inputClass}>
          <option value="" disabled>{roles.loading ? 'Loading roles…' : 'Choose a role'}</option>
          {roles.data?.roles.map((r) => (
            <option key={r.id} value={r.id} disabled={beyondMe(r)}>
              {r.name}{beyondMe(r) ? ' — includes access you don’t have' : ''}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Where it applies">
        <select aria-label="Where it applies" value={scope} onChange={(e) => setScope(e.target.value)} className={inputClass}>
          <option value="TENANT">Everywhere in {scopes.data?.tenant.name ?? 'this tenant'}</option>
          {scopes.data?.organizations.map((o) => (
            <optgroup key={o.id} label={o.name}>
              <option value={`ORGANIZATION:${o.id}`}>{o.name} (whole organization)</option>
              {o.units.map((u) => <option key={u.id} value={`ORG_UNIT:${u.id}`}>{u.name}</option>)}
            </optgroup>
          ))}
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Starts" hint="Leave empty to start now">
          <input type="date" aria-label="Starts" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Ends" hint="Leave empty to keep it">
          <input type="date" aria-label="Ends" value={validTo} min={validFrom || undefined} onChange={(e) => setValidTo(e.target.value)} className={inputClass} />
        </Field>
      </div>
      {datesInvalid && <p className="text-sm text-red-600" role="alert">The end date is before the start date.</p>}

      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={secondaryButtonClass}>Cancel</button>
        <button type="submit" disabled={saving || !principalId || !role || datesInvalid} className={primaryButtonClass}>
          {saving ? 'Assigning…' : 'Assign role'}
        </button>
      </div>
    </Dialog>
  );
}
