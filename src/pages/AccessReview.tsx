import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle, Check, ChevronRight, Clock, Info, Minus, Search, Shield, ShieldCheck, UserCog, Users as UsersIcon, X,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';
import { Badge, Card, DataView, EmptyState, PageHeader, humanize, inputClass } from '../components/ui';
import { validityText } from '../lib/access';

type Kind = 'USER_TYPE' | 'ROLE' | 'GROUP' | 'DELEGATION';
interface Source {
  id: string;
  kind: Kind;
  active: boolean;
  inactiveReason?: string;
  roleId?: string;
  roleName?: string;
  groupId?: string;
  groupName?: string;
  delegatorName?: string;
  scopeType?: string;
  scopeName?: string;
  validFrom?: string;
  validTo?: string | null;
  permissions: string[];
  ignored: string[];
}
interface Review {
  user: { id: string; email: string; name: string | null; userType: string; status: string };
  sources: Source[];
  effective: { permission: string; sources: string[] }[];
  scoped?: { permission: string; sources: string[] }[];
}
interface Catalog {
  resources: { resource: string; label: string; description: string; permissions: { name: string; action: string; description: string }[] }[];
}

const typeLabel = (t: string) => humanize(t.replace(/^(TENANT|PLATFORM)_/, ''));
const KIND_ICON: Record<Kind, typeof Shield> = { USER_TYPE: UserCog, ROLE: Shield, GROUP: UsersIcon, DELEGATION: Clock };

function sourceTitle(s: Source, userType: string) {
  switch (s.kind) {
    case 'USER_TYPE': return `${typeLabel(userType)} defaults`;
    case 'ROLE': return s.roleName!;
    case 'GROUP': return s.roleName ? `${s.groupName} → ${s.roleName}` : s.groupName!;
    case 'DELEGATION': return `${s.roleName} (delegated)`;
  }
}
function sourceChip(s: Source, userType: string) {
  switch (s.kind) {
    case 'USER_TYPE': return `Type: ${typeLabel(userType)}`;
    case 'ROLE': return s.roleName!;
    case 'GROUP': return `${s.groupName}`;
    case 'DELEGATION': return `${s.roleName} · delegated`;
  }
}
function sourceSubtitle(s: Source) {
  switch (s.kind) {
    case 'USER_TYPE': return 'Everyone of this user type gets these';
    case 'ROLE': return 'Assigned directly';
    case 'GROUP': return s.roleName ? 'Through group membership' : 'Group membership';
    case 'DELEGATION': return `Delegated by ${s.delegatorName}`;
  }
}

export default function AccessReview() {
  const { userId } = useParams<{ userId: string }>();
  const { user: me, hasPermission } = useAuth();
  const canReviewOthers = hasPermission('roles:read');
  const targetId = userId ?? (canReviewOthers ? undefined : me?.id);

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Access review"
        description="Everything a person can do in this tenant, and where each permission comes from."
        actions={canReviewOthers && <PersonPicker />}
      />
      {targetId ? <ReviewFor key={targetId} id={targetId} /> : (
        <Card>
          <EmptyState icon={ShieldCheck} title="Choose a person to review"
            message="Search for someone above to see their user type, roles, groups and delegations, and exactly what those let them do." />
        </Card>
      )}
    </div>
  );
}

function PersonPicker() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const q = encodeURIComponent(query.trim());
  const users = useApi<{ data: { id: string; email: string; name: string | null; userType: string }[] }>(open ? `/users?limit=8${q ? `&search=${q}` : ''}` : null);

  return (
    <div className="relative w-full sm:w-80">
      <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
      <input aria-label="Find a person" placeholder="Find a person" value={query} className={`${inputClass} pl-9`}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} onChange={(e) => { setQuery(e.target.value); setOpen(true); }} />
      {open && (users.data?.data.length ?? 0) > 0 && (
        <ul role="listbox" aria-label="People" className="absolute z-20 mt-1 w-full max-h-80 overflow-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg py-1">
          {users.data!.data.map((u) => (
            <li key={u.id} role="option" aria-selected={false}>
              <button type="button" onMouseDown={(e) => e.preventDefault()}
                onClick={() => { setOpen(false); setQuery(''); navigate(`/access-review/${u.id}`); }}
                className="w-full text-left px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-700/50">
                <span className="block text-sm font-medium text-slate-800 dark:text-white">{u.name || u.email}</span>
                <span className="block text-xs text-slate-500">{u.email} · {typeLabel(u.userType)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ReviewFor({ id }: { id: string }) {
  const review = useApi<Review>(`/users/${id}/access`);
  const catalog = useApi<Catalog>('/roles/catalog');
  return (
    <DataView {...review}>
      {(r) => catalog.data ? <ReviewView review={r} catalog={catalog.data} /> : <DataView {...catalog}>{() => null}</DataView>}
    </DataView>
  );
}

function ReviewView({ review, catalog }: { review: Review; catalog: Catalog }) {
  const { user: me, hasPermission } = useAuth();
  const { user, sources, effective, scoped: scopedGrants = [] } = review;
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [showMissing, setShowMissing] = useState(false);

  const byId = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);
  const granted = useMemo(() => new Map(effective.map((e) => [e.permission, e.sources])), [effective]);
  const grantedIn = useMemo(() => new Map(scopedGrants.map((e) => [e.permission, e.sources])), [scopedGrants]);
  const active = sources.filter((s) => s.active);
  const inactive = sources.filter((s) => !s.active);
  const scoped = active.some((s) => s.scopeType && s.scopeType !== 'TENANT');
  const sel = selected ? byId.get(selected) : undefined;
  const isMe = user.id === me?.id;
  const canManage = hasPermission('roles:read');

  const term = filter.trim().toLowerCase();
  const areas = catalog.resources
    .map((r) => ({
      ...r,
      rows: r.permissions.filter((p) =>
        (showMissing || granted.has(p.name) || grantedIn.has(p.name) || (sel && sel.permissions.includes(p.name)))
        && (!term || [r.label, p.name, p.description].some((x) => x.toLowerCase().includes(term)))),
    }))
    .filter((r) => r.rows.length > 0);

  const accountWarning = user.status === 'ACTIVE' ? null
    : user.status === 'PENDING' ? "This person hasn't accepted their invitation yet, so they can't use any of this access."
    : 'This account is deactivated, so none of this access can be used.';

  return (
    <div className="space-y-6">
      {/* Who */}
      <div className="flex flex-wrap items-center gap-4 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-5">
        <div className="flex items-center justify-center w-12 h-12 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-100 font-semibold">
          {(user.name || user.email).slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-slate-800 dark:text-white">{user.name || user.email}</h2>
            {isMe && <span className="text-xs text-slate-400">(you)</span>}
            <Badge value={user.status === 'PENDING' ? 'INVITED' : user.status} />
          </div>
          <p className="text-sm text-slate-500">{user.email} · {typeLabel(user.userType)}</p>
        </div>
        <dl className="flex gap-6 text-center">
          <div><dt className="text-xs text-slate-500">Permissions</dt><dd className="text-2xl font-semibold text-slate-800 dark:text-white">{effective.length}</dd></div>
          <div><dt className="text-xs text-slate-500">In effect</dt><dd className="text-2xl font-semibold text-slate-800 dark:text-white">{active.length}</dd></div>
          <div><dt className="text-xs text-slate-500">Not in effect</dt><dd className="text-2xl font-semibold text-slate-400">{inactive.length}</dd></div>
        </dl>
      </div>

      {accountWarning && (
        <div role="note" className="flex gap-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-500/10 text-sm text-amber-800 dark:text-amber-300">
          <AlertTriangle size={18} className="shrink-0 mt-0.5" /><p>{accountWarning}</p>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[380px_minmax(0,1fr)] items-start">
        {/* Where it comes from */}
        <section aria-label="Where access comes from" className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-slate-800 dark:text-white">Where it comes from</h3>
            {selected && <button onClick={() => setSelected(null)} className="text-xs text-blue-600 hover:text-blue-700">Show all</button>}
          </div>
          <p className="text-xs text-slate-500">Select a source to see exactly what it grants.</p>
          <ul className="space-y-2">
            {active.map((s) => <SourceCard key={s.id} s={s} userType={user.userType} selected={selected === s.id} onSelect={() => setSelected(selected === s.id ? null : s.id)} canManage={canManage} />)}
          </ul>
          {inactive.length > 0 && (
            <>
              <h4 className="pt-2 text-xs font-medium text-slate-400">Not in effect</h4>
              <ul className="space-y-2">
                {inactive.map((s) => <SourceCard key={s.id} s={s} userType={user.userType} selected={selected === s.id} onSelect={() => setSelected(selected === s.id ? null : s.id)} canManage={canManage} />)}
              </ul>
            </>
          )}
          {scoped && (
            <p className="flex gap-2 text-xs text-slate-500">
              <Info size={14} className="shrink-0 mt-0.5" />
              Some roles are assigned to an organization or unit. Their permissions apply there only, and are marked "in part" below.
            </p>
          )}
        </section>

        {/* What they can do */}
        <section aria-label="What they can do" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-semibold text-slate-800 dark:text-white">
              {sel ? <>What <span className="text-blue-600">{sourceTitle(sel, user.userType)}</span> grants</> : isMe ? 'What you can do' : 'What they can do'}
            </h3>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
                <input type="checkbox" className="rounded" checked={showMissing} onChange={(e) => setShowMissing(e.target.checked)} />
                Show what {isMe ? "you can't" : "they can't"} do
              </label>
              <div className="relative w-56">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input aria-label="Filter permissions" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} className={`${inputClass} pl-8 py-1.5`} />
              </div>
            </div>
          </div>
          {sel && !sel.active && (
            <p className="text-sm text-slate-500">This source isn't in effect ({sel.inactiveReason?.toLowerCase()}), so these permissions aren't granted by it right now.</p>
          )}

          {areas.length === 0 ? (
            <Card><EmptyState icon={Shield} title={term ? 'No permissions match' : 'No permissions'} /></Card>
          ) : (
            <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-700">
              {areas.map((a) => (
                <div key={a.resource} className="px-5 py-3">
                  <p className="text-xs font-medium text-slate-400 mb-1">{a.label}</p>
                  <ul>
                    {a.rows.map((p) => {
                      const across = granted.get(p.name) ?? [];
                      const inPart = across.length ? [] : (grantedIn.get(p.name) ?? []);
                      const from = [...across, ...inPart];
                      const has = across.length > 0;
                      const fromSel = sel?.permissions.includes(p.name);
                      const dim = sel && !fromSel;
                      return (
                        <li key={p.name} className={`flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 ${dim ? 'opacity-35' : ''}`}>
                          <span className={`flex items-center justify-center w-5 h-5 rounded-full shrink-0 ${has ? 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-400' : inPart.length ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400' : 'bg-slate-100 text-slate-400 dark:bg-slate-700'}`}
                            aria-label={has ? 'Granted' : inPart.length ? 'Granted in some organizations or units' : 'Not granted'}>
                            {has || inPart.length ? <Check size={12} /> : <Minus size={12} />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className={`text-sm ${has || inPart.length ? 'text-slate-800 dark:text-slate-100' : 'text-slate-400'}`}>{p.description}</span>
                            {inPart.length > 0 && <span className="ml-2 text-xs text-amber-700 dark:text-amber-400">in part</span>}
                            <code className="ml-2 text-xs text-slate-400">{p.name}</code>
                          </span>
                          <span className="flex flex-wrap gap-1">
                            {from.map((sid) => {
                              const s = byId.get(sid)!;
                              return (
                                <button key={sid} type="button" onClick={() => setSelected(sid)}
                                  className={`px-2 py-0.5 rounded-md text-xs ${selected === sid
                                    ? 'bg-blue-600 text-white'
                                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-300'}`}>
                                  {sourceChip(s, user.userType)}{s.scopeType && s.scopeType !== 'TENANT' ? ` · ${s.scopeName}` : ''}
                                </button>
                              );
                            })}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function SourceCard({ s, userType, selected, onSelect, canManage }: {
  s: Source; userType: string; selected: boolean; onSelect: () => void; canManage: boolean;
}) {
  const Icon = KIND_ICON[s.kind];
  const link = !canManage ? null
    : s.kind === 'GROUP' && s.groupId ? { to: `/groups?group=${s.groupId}`, label: 'Open group' }
    : s.roleId ? { to: `/roles/${s.roleId}`, label: 'Open role' }
    : null;
  return (
    <li>
      <div className={`rounded-lg border p-3 transition ${selected
        ? 'border-blue-500 ring-2 ring-blue-500/20 bg-blue-50/50 dark:bg-blue-500/10'
        : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800'} ${s.active ? '' : 'opacity-70'}`}>
        <button type="button" onClick={onSelect} aria-pressed={selected} className="w-full text-left flex items-start gap-3">
          <span className={`flex items-center justify-center w-8 h-8 rounded-lg shrink-0 ${s.active ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300' : 'bg-slate-100 text-slate-400 dark:bg-slate-700'}`}>
            <Icon size={16} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-slate-800 dark:text-white">{sourceTitle(s, userType)}</span>
            <span className="block text-xs text-slate-500">
              {sourceSubtitle(s)}
              {s.scopeType && s.scopeType !== 'TENANT' && ` · ${s.scopeName}`}
              {s.validFrom && s.kind !== 'USER_TYPE' && (s.validTo || new Date(s.validFrom) > new Date()) && ` · ${validityText(s.validFrom, s.validTo ?? null)}`}
            </span>
            {!s.active && s.inactiveReason && (
              <span className="mt-1 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400"><X size={12} />{s.inactiveReason}</span>
            )}
            {s.ignored.length > 0 && (
              <span className="mt-1 block text-xs text-slate-500">Ignored: {s.ignored.join(', ')} (platform-level, can't be granted by a tenant role)</span>
            )}
          </span>
          <span className="shrink-0 text-right">
            <span className="block text-sm font-semibold text-slate-700 dark:text-slate-200">{s.permissions.length}</span>
            <ChevronRight size={14} className={`ml-auto text-slate-400 transition ${selected ? 'rotate-90' : ''}`} />
          </span>
        </button>
        {link && selected && (
          <Link to={link.to} className="mt-2 ml-11 inline-block text-xs font-medium text-blue-600 hover:text-blue-700">{link.label}</Link>
        )}
      </div>
    </li>
  );
}

