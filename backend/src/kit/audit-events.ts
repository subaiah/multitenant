/**
 * Every kind of audit entry the kit records (lib/audit.ts). The product adds
 * its own through ProductModule.auditEvents. Recording a key that isn't in
 * either catalog is an error, so the Audit Log's filters always know every
 * event; test/audit.test.ts also checks every key used in the code is here.
 *
 * scope: where the entry goes. 'tenant' entries go in the tenant's own audit
 * log (the request's tenant); 'platform' entries in the platform's, with the
 * tenant they concern, if any.
 */
export type AuditCategory = 'security' | 'account' | 'access' | 'config' | 'tenant' | 'platform' | 'audit' | 'data';

export interface AuditEventDefinition {
  label: string;
  category: AuditCategory;
  scope: 'tenant' | 'platform';
}

const t = (label: string, category: AuditCategory): AuditEventDefinition => ({ label, category, scope: 'tenant' });
const p = (label: string, category: AuditCategory): AuditEventDefinition => ({ label, category, scope: 'platform' });

export const KIT_AUDIT_EVENTS = {
  // Signing in (tenant users in their tenant's log, platform users in the platform's)
  'auth.signed_in': t('Signed in', 'security'),
  'auth.sign_in_failed': t('Sign-in failed', 'security'),
  'auth.mfa_failed': t('Two-factor code rejected', 'security'),
  'auth.signed_out_everywhere': t('Signed out everywhere', 'security'),
  'auth.password_reset': t('Password reset', 'security'),
  'account.password_changed': t('Password changed', 'security'),
  'account.email_change_requested': t('Email change requested', 'account'),
  'account.email_changed': t('Email address changed', 'security'),
  'user.email_change_requested': t("A user's email change requested by an administrator", 'access'),
  'auth.invitation_accepted': t('Invitation accepted', 'account'),
  'platform.auth.signed_in': p('Platform user signed in', 'security'),
  'platform.auth.sign_in_failed': p('Platform sign-in failed', 'security'),
  'platform.auth.mfa_failed': p('Platform two-factor code rejected', 'security'),
  'platform.auth.signed_out_everywhere': p('Platform user signed out everywhere', 'security'),

  // Own account
  'account.mfa_enabled': t('Two-factor turned on', 'account'),
  'account.mfa_disabled': t('Two-factor turned off', 'account'),
  'account.recovery_codes_regenerated': t('New recovery codes made', 'account'),
  'platform.account.mfa_enabled': p('Platform user turned on two-factor', 'account'),
  'platform.account.password_changed': p('Platform user changed their password', 'account'),
  'platform.account.email_change_requested': p('Platform user asked to change their email', 'account'),
  'platform.account.email_changed': p('Platform user changed their email', 'account'),
  'platform.account.mfa_disabled': p('Platform user turned off two-factor', 'account'),
  'platform.account.recovery_codes_regenerated': p('Platform user made new recovery codes', 'account'),

  // Users
  'user.invited': t('User invited', 'access'),
  'user.invitation_resent': t('Invitation resent', 'access'),
  'user.created_by_sso': t('User created at single sign-on', 'access'),
  'user.updated': t('User changed', 'access'),
  'user.deactivated': t('User deactivated', 'access'),
  'user.reactivated': t('User reactivated', 'access'),
  'user.deleted': t('User removed', 'access'),
  'user.mfa_reset': t('Two-factor reset by an admin', 'security'),

  // Roles, groups, delegation, policies, requests, reviews
  'role.created': t('Role created', 'access'),
  'role.updated': t('Role changed', 'access'),
  'role.deleted': t('Role deleted', 'access'),
  'role.assigned': t('Role assigned', 'access'),
  'role.unassigned': t('Role assignment removed', 'access'),
  'roles.initialized': t('Default roles created', 'access'),
  'group.created': t('Group created', 'access'),
  'group.updated': t('Group changed', 'access'),
  'group.deleted': t('Group deleted', 'access'),
  'group.member_added': t('Added to group', 'access'),
  'group.member_removed': t('Removed from group', 'access'),
  'delegation.created': t('Delegation created', 'access'),
  'delegation.revoked': t('Delegation revoked', 'access'),
  'policy.created': t('Policy created', 'access'),
  'policy.updated': t('Policy changed', 'access'),
  'policy.deleted': t('Policy deleted', 'access'),
  'access_request.created': t('Access requested', 'access'),
  'access_request.decided': t('Access request decided', 'access'),
  'certification.created': t('Access review started', 'access'),
  'certification.completed': t('Access review completed', 'access'),

  // Organization structure
  'custom_domain.added': t('Custom domain added', 'config'),
  'custom_domain.verified': t('Custom domain verified', 'config'),
  'custom_domain.removed': t('Custom domain removed', 'config'),
  'custom_domain.unverified': t('Custom domain no longer verified', 'config'),
  'organization.created': t('Organization created', 'config'),
  'organization.updated': t('Organization changed', 'config'),
  'organization.deleted': t('Organization deleted', 'config'),
  'organization.member_added': t('Added to organization', 'access'),
  'organization.member_removed': t('Removed from organization', 'access'),
  'org_unit.created': t('Org unit created', 'config'),
  'org_unit.updated': t('Org unit changed', 'config'),
  'org_unit.deleted': t('Org unit deleted', 'config'),
  'org_unit.member_added': t('Added to org unit', 'access'),
  'org_unit.member_removed': t('Removed from org unit', 'access'),

  // Tenant settings
  'auth_config.updated': t('Sign-in settings changed', 'security'),
  'auth_provider.added': t('Identity provider added', 'security'),
  'auth_provider.updated': t('Identity provider changed', 'security'),
  'auth_provider.removed': t('Identity provider removed', 'security'),
  'api_config.updated': t('API settings changed', 'config'),
  'database_config.updated': t('Database settings changed', 'config'),
  'entitlement.updated': t('Application entitlement changed', 'config'),
  'tenant_profile.updated': t('Organization profile changed', 'config'),
  'notification_settings.updated': t('Notification settings changed', 'config'),
  // Platform support working in this tenant (also in the platform's log)
  'support.session_started': t('Platform support session started', 'security'),
  'support.session_ended': t('Platform support session ended', 'security'),

  // The audit log itself
  'audit.exported': t('Audit log exported', 'audit'),
  'data_export.requested': t('Data export requested', 'data'),
  'data_export.downloaded': t('Data export downloaded', 'data'),
  'notifications.test_email_sent': t('Test email sent', 'config'),
  'audit.archived': t('Old audit entries archived', 'audit'),
  'platform.audit.exported': p('Platform audit log exported', 'audit'),
  'platform.audit.archived': p('Old platform audit entries archived', 'audit'),

  // Platform: tenants
  'tenant.created': p('Tenant created', 'tenant'),
  'tenant.signed_up': p('Organization signed up', 'tenant'),
  'tenant.trial_ended': p('Trial ended', 'tenant'),
  'tenant.closed': p('Organization closed by its admins', 'tenant'),
  'tenant.restored': p('Closed organization restored', 'tenant'),
  'tenant.updated': p('Tenant changed', 'tenant'),
  'tenant.deleted': p('Tenant deleted', 'tenant'),
  'tenant.provisioned': p('Tenant set up', 'tenant'),
  'tenant.provisioning_failed': p('Tenant setup failed', 'tenant'),
  'tenant.provisioning_retried': p('Tenant setup retried', 'tenant'),
  'tenant.credentials_rotated': p('Tenant database credentials rotated', 'tenant'),
  'tenant.invitation_resent': p("Tenant's first administrator invited again", 'tenant'),
  'tenant.invitation_not_sent': p("Tenant's first administrator's invitation email failed", 'tenant'),
  'platform.test_email_sent': p('Test email sent', 'config'),
  'tenant.migrations_run': p('Tenant migrations run', 'tenant'),

  // Platform: catalogue, menus, people, support
  'application.created': p('Application added to the catalogue', 'platform'),
  'application.updated': p('Application changed', 'platform'),
  'application.deleted': p('Application removed from the catalogue', 'platform'),
  'menu.changed': p('Menu changed', 'platform'),
  'permission.created': p('Permission added', 'platform'),
  'permission.deleted': p('Permission removed', 'platform'),
  'platform_user.mfa_reset': p('Platform user two-factor reset', 'security'),
  'platform_role.created': p('Platform role created', 'platform'),
  'platform_role.updated': p('Platform role changed', 'platform'),
  'platform_role.deleted': p('Platform role deleted', 'platform'),
  'platform_role.assigned': p('Platform role given', 'security'),
  'platform_role.unassigned': p('Platform role taken away', 'security'),
  'support_session.requested': p('Support session requested', 'security'),
  'support_session.approved': p('Support session approved (started)', 'security'),
  'support_session.rejected': p('Support session rejected', 'security'),
  'support_session.revoked': p('Support session ended', 'security'),
} satisfies Record<string, AuditEventDefinition>;

export type KitAuditEvent = keyof typeof KIT_AUDIT_EVENTS;
