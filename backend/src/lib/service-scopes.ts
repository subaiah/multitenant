/**
 * What an external product's service credential may be allowed to do
 * (lib/product-service.ts). Kept free of other imports: the API v1 contract
 * (src/api/v1.ts) and its CLI read it without a database.
 */
export const SERVICE_SCOPES = {
  'organizations.read': 'See the organizations that have the product turned on, and their setup status',
  'members.read': 'See the people, groups and units in those organizations',
  'lifecycle.report': 'Report the result of setting an organization up',
  'notifications.send': 'Send its declared notifications to people in those organizations',
  'audit.write': 'Write its declared events to those organizations’ audit logs',
  'events.publish': 'Publish its declared events to other applications and webhooks in those organizations',
  'launcher.read': 'See which of those organizations’ applications each person can open (the application launcher)',
} as const;
export type ServiceScope = keyof typeof SERVICE_SCOPES;
export const isServiceScope = (s: string): s is ServiceScope => Object.prototype.hasOwnProperty.call(SERVICE_SCOPES, s);
