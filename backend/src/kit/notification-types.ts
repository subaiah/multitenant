/**
 * Kinds of notifications (lib/notifications.ts). Each key is also the audit
 * event that raises it (kit/audit-events.ts): when that entry is recorded,
 * the notification goes to its audience. A product adds its own through
 * ProductModule.notificationTypes, raised by its own audit events or directly
 * with notify().
 *
 * Who gets it is decided per type (audience), then per organization (the
 * Notifications settings: off, which channels, mandatory) and per person
 * (their preferences), except that mandatory types can't be turned off.
 */
export type NotificationCategory = 'security' | 'account' | 'access' | 'settings' | 'tenants' | 'support' | 'product';

/** What a notification is about: the audit entry that raised it, or notify()'s input. */
export interface NotifyEvent {
  type: string;
  occurredAt: string;
  actor: { type: string; id?: string | null; email?: string | null };
  resource: { type?: string | null; id?: string | null; label?: string | null };
  changes?: Record<string, [unknown, unknown]> | null;
  details?: Record<string, unknown> | null;
  ip?: string | null;
  /** The tenant's name (tenant notifications) */
  tenantName?: string;
}

export interface Audience {
  /** These users (ids; empty values are ignored) */
  userIds?: (string | null | undefined | unknown)[];
  /** Members of these groups */
  groupIds?: (string | null | undefined | unknown)[];
  /** Everyone (active) with this permission */
  permission?: string;
  /** Not the person who did it */
  excludeActor?: boolean;
}

export interface NotificationType {
  label: string;
  description: string;
  category: NotificationCategory;
  /** tenant: the tenant's users; platform: platform users */
  scope: 'tenant' | 'platform';
  audience: (e: NotifyEvent) => Audience;
  /** Channels when neither the organization nor the person has said otherwise */
  defaults: { inApp: boolean; email: boolean };
  /** People can't turn it off (organizations can still choose the channels) */
  mandatory?: boolean;
  render: (e: NotifyEvent) => { title: string; body?: string; link?: string };
}

const who = (e: NotifyEvent) => e.actor.email ?? (e.actor.type === 'SYSTEM' ? 'The system' : 'Someone');
const d = (e: NotifyEvent, key: string) => e.details?.[key] as string | undefined;
const when = (e: NotifyEvent) => new Date(e.occurredAt).toUTCString();

export const KIT_NOTIFICATION_TYPES: Record<string, NotificationType> = {
  // ---- Your account (security)
  'auth.mfa_failed': {
    label: 'Two-factor code rejected at sign-in',
    description: 'Your password was entered correctly, but the two-factor code was wrong',
    category: 'security',
    scope: 'tenant',
    mandatory: true,
    defaults: { inApp: true, email: true },
    audience: (e) => ({ userIds: [e.actor.id] }),
    render: (e) => ({
      title: 'Someone tried to sign in to your account',
      body: `Your password was entered correctly but the two-factor code was wrong (${when(e)}, from ${e.ip ?? 'an unknown address'}). If this wasn't you, change your password now.`,
      link: '/profile',
    }),
  },
  'auth.password_reset': {
    label: 'Password changed',
    description: 'Your password was reset',
    category: 'security',
    scope: 'tenant',
    mandatory: true,
    defaults: { inApp: true, email: true },
    audience: (e) => ({ userIds: [e.actor.id] }),
    render: (e) => ({ title: 'Your password was changed', body: `Your password was reset on ${when(e)}. If you didn't do this, contact your administrator.`, link: '/profile' }),
  },
  'account.mfa_disabled': {
    label: 'Two-factor turned off',
    description: 'Two-factor sign-in was turned off on your account',
    category: 'security',
    scope: 'tenant',
    mandatory: true,
    defaults: { inApp: true, email: true },
    audience: (e) => ({ userIds: [e.actor.id] }),
    render: (e) => ({ title: 'Two-factor sign-in was turned off', body: `Two-factor sign-in was turned off on your account on ${when(e)}. If you didn't do this, turn it back on and change your password.`, link: '/profile' }),
  },
  'account.recovery_codes_regenerated': {
    label: 'New recovery codes',
    description: 'New two-factor recovery codes were made for your account',
    category: 'security',
    scope: 'tenant',
    defaults: { inApp: true, email: true },
    audience: (e) => ({ userIds: [e.actor.id] }),
    render: () => ({ title: 'New recovery codes were made', body: 'Your previous recovery codes no longer work.', link: '/profile' }),
  },
  'user.mfa_reset': {
    label: 'Two-factor reset by an administrator',
    description: 'An administrator reset your two-factor sign-in',
    category: 'security',
    scope: 'tenant',
    mandatory: true,
    defaults: { inApp: true, email: true },
    audience: (e) => ({ userIds: [e.resource.id] }),
    render: (e) => ({ title: 'Your two-factor sign-in was reset', body: `${who(e)} reset your two-factor sign-in. You'll set it up again the next time you sign in.`, link: '/profile' }),
  },

  // ---- Your access
  'user.updated': {
    label: 'Your user type changed',
    description: 'An administrator changed your user type',
    category: 'access',
    scope: 'tenant',
    defaults: { inApp: true, email: true },
    // Only when the type changed (a name change isn't worth a message)
    audience: (e) => ({ userIds: e.changes?.userType ? [e.resource.id] : [], excludeActor: true }),
    render: (e) => ({
      title: `You are now ${String(e.changes?.userType?.[1] ?? '').replace('TENANT_', '').toLowerCase().replace('_', ' ')}`,
      body: `${who(e)} changed your user type, which changes what you can do.`,
      link: '/profile',
    }),
  },
  'role.assigned': {
    label: 'Role given to you',
    description: 'You (or a group you are in) were given a role',
    category: 'access',
    scope: 'tenant',
    defaults: { inApp: true, email: true },
    audience: (e) => (d(e, 'principalType') === 'GROUP'
      ? { groupIds: [d(e, 'principalId')], excludeActor: true }
      : { userIds: [d(e, 'principalId')], excludeActor: true }),
    render: (e) => ({
      title: `You were given the ${d(e, 'role')} role`,
      body: `${who(e)} gave ${d(e, 'principalType') === 'GROUP' ? `the ${d(e, 'principal')} group` : 'you'} the ${d(e, 'role')} role${d(e, 'validTo') ? ` until ${new Date(d(e, 'validTo')!).toLocaleDateString()}` : ''}.`,
      link: '/profile',
    }),
  },
  'role.unassigned': {
    label: 'Role taken away',
    description: 'A role was removed from you (or a group you are in)',
    category: 'access',
    scope: 'tenant',
    defaults: { inApp: true, email: false },
    audience: (e) => (d(e, 'principalType') === 'GROUP'
      ? { groupIds: [d(e, 'principalId')], excludeActor: true }
      : { userIds: [d(e, 'principalId')], excludeActor: true }),
    render: (e) => ({ title: `The ${d(e, 'role')} role was removed`, body: `${who(e)} removed the ${d(e, 'role')} role from ${d(e, 'principalType') === 'GROUP' ? `the ${d(e, 'principal')} group` : 'you'}.`, link: '/profile' }),
  },
  'group.member_added': {
    label: 'Added to a group',
    description: 'You were added to a group',
    category: 'access',
    scope: 'tenant',
    defaults: { inApp: true, email: false },
    audience: (e) => ({ userIds: [d(e, 'userId')], excludeActor: true }),
    render: (e) => ({ title: `You were added to ${e.resource.label}`, body: `${who(e)} added you to the ${e.resource.label} group.`, link: '/profile' }),
  },
  'group.member_removed': {
    label: 'Removed from a group',
    description: 'You were removed from a group',
    category: 'access',
    scope: 'tenant',
    defaults: { inApp: true, email: false },
    audience: (e) => ({ userIds: [d(e, 'userId')], excludeActor: true }),
    render: (e) => ({ title: `You were removed from ${e.resource.label}`, body: `${who(e)} removed you from the ${e.resource.label} group.`, link: '/profile' }),
  },
  'delegation.created': {
    label: 'Role delegated to you',
    description: 'Someone handed you one of their roles for a while',
    category: 'access',
    scope: 'tenant',
    defaults: { inApp: true, email: true },
    audience: (e) => ({ userIds: [d(e, 'delegateId')] }),
    render: (e) => ({ title: 'A role was delegated to you', body: `${who(e)} delegated one of their roles to you${d(e, 'validTo') ? ` until ${new Date(d(e, 'validTo')!).toLocaleDateString()}` : ''}.`, link: '/profile' }),
  },
  'access_request.created': {
    label: 'Access requested',
    description: 'Someone asked for a role (for people who approve requests)',
    category: 'access',
    scope: 'tenant',
    defaults: { inApp: true, email: true },
    audience: () => ({ permission: 'access-requests:approve', excludeActor: true }),
    render: (e) => ({ title: `${who(e)} asked for the ${e.resource.label} role`, body: d(e, 'reason') ? `Reason: ${d(e, 'reason')}` : undefined, link: '/role-assignments' }),
  },
  'access_request.decided': {
    label: 'Your access request was decided',
    description: 'A role you asked for was approved or denied',
    category: 'access',
    scope: 'tenant',
    defaults: { inApp: true, email: true },
    audience: (e) => ({ userIds: [d(e, 'requesterId')], excludeActor: true }),
    render: (e) => ({
      title: d(e, 'decision') === 'APPROVED' ? 'Your access request was approved' : 'Your access request was denied',
      body: d(e, 'decision') === 'APPROVED' ? `${who(e)} approved it.` : `${who(e)} denied it${d(e, 'reason') ? `: ${d(e, 'reason')}` : '.'}`,
      link: '/profile',
    }),
  },

  // ---- Organization settings (for the people who manage them)
  'auth_config.updated': {
    label: 'Sign-in settings changed',
    description: 'Someone changed the organization’s sign-in settings',
    category: 'settings',
    scope: 'tenant',
    defaults: { inApp: true, email: false },
    audience: () => ({ permission: 'auth:manage', excludeActor: true }),
    render: (e) => ({ title: 'Sign-in settings were changed', body: `${who(e)} changed: ${Object.keys(e.changes ?? {}).join(', ') || 'settings'}.`, link: '/authentication' }),
  },
  'auth_provider.added': {
    label: 'Identity provider added',
    description: 'A single sign-on provider was added',
    category: 'settings',
    scope: 'tenant',
    defaults: { inApp: true, email: true },
    audience: () => ({ permission: 'auth:manage', excludeActor: true }),
    render: (e) => ({ title: `${e.resource.label} sign-in was added`, body: `${who(e)} added an identity provider.`, link: '/authentication' }),
  },
  'auth_provider.removed': {
    label: 'Identity provider removed',
    description: 'A single sign-on provider was removed',
    category: 'settings',
    scope: 'tenant',
    defaults: { inApp: true, email: true },
    audience: () => ({ permission: 'auth:manage', excludeActor: true }),
    render: (e) => ({ title: `${e.resource.label} sign-in was removed`, body: `${who(e)} removed an identity provider.`, link: '/authentication' }),
  },
  'user.created_by_sso': {
    label: 'New user from single sign-on',
    description: 'Someone got an account by signing in with an identity provider',
    category: 'access',
    scope: 'tenant',
    defaults: { inApp: true, email: false },
    audience: () => ({ permission: 'users:create', excludeActor: true }),
    render: (e) => ({ title: `${e.resource.label} joined through single sign-on`, link: '/users' }),
  },
  'support.session_started': {
    label: 'Platform support working in your organization',
    description: 'Platform support staff started a support session',
    category: 'support',
    scope: 'tenant',
    defaults: { inApp: true, email: true },
    audience: () => ({ permission: 'audit:read' }),
    render: (e) => ({ title: 'A platform support session started', body: `${who(e)} can work in your organization until ${d(e, 'validTo') ? new Date(d(e, 'validTo')!).toUTCString() : 'it ends'}. Reason: ${d(e, 'reason') ?? '—'}. Everything they do is in the audit log.`, link: '/audit-log' }),
  },

  // ---- Platform
  'platform.auth.mfa_failed': {
    label: 'Two-factor code rejected at sign-in',
    description: 'Your password was entered correctly, but the two-factor code was wrong',
    category: 'security',
    scope: 'platform',
    mandatory: true,
    defaults: { inApp: true, email: true },
    audience: (e) => ({ userIds: [e.actor.id] }),
    render: (e) => ({ title: 'Someone tried to sign in to your platform account', body: `The password was right but the two-factor code was wrong (${when(e)}). If this wasn't you, change your password now.`, link: '/platform/users' }),
  },
  'platform.account.mfa_disabled': {
    label: 'Two-factor turned off',
    description: 'Two-factor sign-in was turned off on your account',
    category: 'security',
    scope: 'platform',
    mandatory: true,
    defaults: { inApp: true, email: true },
    audience: (e) => ({ userIds: [e.actor.id] }),
    render: (e) => ({ title: 'Two-factor sign-in was turned off', body: `Two-factor sign-in was turned off on your platform account on ${when(e)}.`, link: '/platform/users' }),
  },
  'platform_user.mfa_reset': {
    label: 'Two-factor reset by an administrator',
    description: 'A platform admin reset your two-factor sign-in',
    category: 'security',
    scope: 'platform',
    mandatory: true,
    defaults: { inApp: true, email: true },
    audience: (e) => ({ userIds: [e.resource.id] }),
    render: (e) => ({ title: 'Your two-factor sign-in was reset', body: `${who(e)} reset it; you'll set it up again at your next sign-in.`, link: '/platform/users' }),
  },
  'tenant.provisioning_failed': {
    label: 'Tenant setup failed',
    description: 'Setting up a new tenant’s database failed',
    category: 'tenants',
    scope: 'platform',
    defaults: { inApp: true, email: true },
    audience: () => ({ permission: 'tenants:manage' }),
    render: (e) => ({ title: `Setting up ${e.resource.label} failed`, body: d(e, 'error'), link: '/platform/tenants' }),
  },
  'tenant.provisioned': {
    label: 'Tenant ready',
    description: 'A new tenant finished setting up',
    category: 'tenants',
    scope: 'platform',
    defaults: { inApp: true, email: false },
    audience: () => ({ permission: 'tenants:manage' }),
    render: (e) => ({ title: `${e.resource.label} is ready`, link: '/platform/tenants' }),
  },
  'tenant.deleted': {
    label: 'Tenant deleted',
    description: 'A tenant and its data were deleted',
    category: 'tenants',
    scope: 'platform',
    defaults: { inApp: true, email: true },
    audience: () => ({ permission: 'tenants:manage', excludeActor: true }),
    render: (e) => ({ title: `${e.resource.label} was deleted`, body: `${who(e)} deleted the tenant and its data (its audit log was archived).`, link: '/platform/tenants' }),
  },
  'support_session.created': {
    label: 'Support session started',
    description: 'Someone started a support session in a tenant',
    category: 'support',
    scope: 'platform',
    defaults: { inApp: true, email: false },
    audience: () => ({ permission: 'support:manage', excludeActor: true }),
    render: (e) => ({ title: `${who(e)} started a support session in ${e.resource.label}`, body: d(e, 'reason') ? `Reason: ${d(e, 'reason')}` : undefined, link: '/platform/audit' }),
  },
};
