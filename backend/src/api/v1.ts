/**
 * API v1: the routes other systems may rely on, and their exact shapes.
 * docs/API_V1.md.
 *
 * Every route is reachable under /v1 (server.ts rewrites /v1/... to /...),
 * but only the ones listed here are the contract: documented in the OpenAPI
 * document (GET /v1/openapi.json, and docs/api/openapi-v1.json in the repo),
 * covered by the generated client (clients/typescript), and kept compatible
 * within v1:
 *
 *   - fields, routes and optional parameters may be added;
 *   - nothing listed here is removed, renamed or changes type, and no
 *     parameter becomes required.
 *
 * test/api-v1.test.ts holds the code to that: it calls every route listed
 * here with an API key and checks the answers against these schemas, and it
 * compares this contract with the committed document, refusing breaking
 * changes. Responses may carry more fields than are listed; only the listed
 * ones are promised.
 */

type Schema = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

const uuid = { type: 'string', format: 'uuid' } as const;
const dateTime = { type: 'string', format: 'date-time' } as const;
const nullable = (s: Schema) => ({ ...s, type: [s.type as string, 'null'] });
const obj = (properties: Record<string, Schema>, required: string[] = Object.keys(properties), extra: Schema = {}): Schema => ({
  type: 'object', properties, required, ...extra,
});
const arrayOf = (items: Schema) => ({ type: 'array', items });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const USER_TYPES = ['TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_DEVELOPER', 'TENANT_USER', 'TENANT_VIEWER'];
const ACTIVE_INACTIVE = ['ACTIVE', 'INACTIVE'];

export const SCHEMAS: Record<string, Schema> = {
  Pagination: obj({ page: { type: 'integer' }, limit: { type: 'integer' }, total: { type: 'integer' }, pages: { type: 'integer' } }),
  Error: obj({ error: { type: 'string' }, message: { type: 'string' }, code: { type: 'string' } }, ['error'], { description: 'Every error: a 4xx or 5xx with this body. `code` says which, where it matters.' }),

  User: obj({
    id: uuid, email: { type: 'string', format: 'email' }, name: { type: 'string' },
    userType: { type: 'string', enum: USER_TYPES }, status: { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'PENDING'] },
    lastLoginAt: nullable(dateTime), createdAt: dateTime,
  }),
  UserInList: { allOf: [ref('User'), obj({ mfaEnabled: { type: 'boolean' } })] },
  UserInvited: obj({
    id: uuid, email: { type: 'string', format: 'email' }, name: { type: 'string' }, userType: { type: 'string', enum: USER_TYPES },
    status: { type: 'string', enum: ['PENDING'] }, createdAt: dateTime,
    invitationSent: { type: 'boolean', description: 'Whether the invitation email went out; when it didn’t, `inviteLink` is the link to share another way' },
    inviteLink: { type: 'string' },
  }, ['id', 'email', 'name', 'userType', 'status', 'createdAt', 'invitationSent']),
  UserUpdated: obj({
    id: uuid, email: { type: 'string', format: 'email' }, name: { type: 'string' }, userType: { type: 'string', enum: USER_TYPES },
    status: { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'PENDING'] }, updatedAt: dateTime,
  }),

  Group: obj({
    id: uuid, name: { type: 'string' }, description: nullable({ type: 'string' }),
    groupType: { type: 'string', enum: ['MANUAL', 'SYNCED', 'RULE_BASED'] }, status: { type: 'string', enum: ACTIVE_INACTIVE },
    createdAt: dateTime, updatedAt: dateTime,
  }),
  GroupInList: { allOf: [ref('Group'), obj({ _count: obj({ members: { type: 'integer' }, roleAssignments: { type: 'integer' } }), roles: arrayOf({ type: 'string' }) })] },
  GroupMembership: obj({ id: uuid, groupId: uuid, userId: uuid, validFrom: dateTime, validTo: nullable(dateTime), createdAt: dateTime }),
  GroupDetail: {
    allOf: [ref('Group'), obj({
      members: arrayOf({ allOf: [ref('GroupMembership'), obj({ user: obj({ id: uuid, email: { type: 'string' }, name: { type: 'string' }, userType: { type: 'string' }, status: { type: 'string' } }) })] }),
    })],
  },

  Organization: obj({
    id: uuid, name: { type: 'string' }, description: nullable({ type: 'string' }), status: { type: 'string', enum: ACTIVE_INACTIVE },
    createdAt: dateTime, updatedAt: dateTime,
  }),
  OrganizationInList: {
    allOf: [ref('Organization'), obj({
      _count: obj({ units: { type: 'integer' }, memberships: { type: 'integer' } }),
      access: { type: 'string', enum: ['TENANT', 'ORGANIZATION', 'UNITS'], description: 'Why the caller sees it: everywhere, this organization, or some of its units' },
      can: obj({ update: { type: 'boolean' }, delete: { type: 'boolean' } }),
    })],
  },
  OrganizationMembership: obj({ id: uuid, userId: uuid, organizationId: uuid, orgUnitId: nullable(uuid), createdAt: dateTime }),
  OrganizationDetail: { allOf: [ref('Organization'), obj({ units: arrayOf({ type: 'object' }), memberships: arrayOf({ type: 'object' }) })] },

  Role: obj({
    id: uuid, name: { type: 'string' }, description: nullable({ type: 'string' }), isSystem: { type: 'boolean' },
    permissions: arrayOf(obj({ permission: { type: 'string' } })), createdAt: dateTime, updatedAt: dateTime,
  }),
  RoleAssignment: obj({
    id: uuid, roleId: uuid, principalType: { type: 'string', enum: ['USER', 'GROUP'] }, userId: nullable(uuid), groupId: nullable(uuid),
    scopeType: { type: 'string', enum: ['TENANT', 'ORGANIZATION', 'ORG_UNIT', 'RESOURCE'] }, scopeId: nullable({ type: 'string' }),
    validFrom: dateTime, validTo: nullable(dateTime), status: { type: 'string' },
  }),
  RoleAssignmentInList: {
    allOf: [ref('RoleAssignment'), obj({
      roleName: { type: 'string' }, principalName: nullable({ type: 'string' }), scopeName: nullable({ type: 'string' }),
      state: { type: 'string', description: 'ACTIVE, SCHEDULED or EXPIRED, from the validity dates' }, permissions: arrayOf({ type: 'string' }),
    })],
  },

  AuditEntry: obj({
    seq: { type: 'integer', description: 'Position in the organization’s audit chain; page with ?before=' },
    occurredAt: dateTime, event: { type: 'string' }, category: { type: 'string' }, outcome: { type: 'string', enum: ['SUCCESS', 'FAILURE'] },
    actorType: { type: 'string', enum: ['USER', 'PLATFORM', 'SYSTEM', 'ANONYMOUS', 'API_KEY'] }, actorId: nullable({ type: 'string' }), actorEmail: nullable({ type: 'string' }),
    resourceType: nullable({ type: 'string' }), resourceId: nullable({ type: 'string' }), resourceLabel: nullable({ type: 'string' }),
    changes: {}, details: {}, requestId: nullable({ type: 'string' }), hash: { type: 'string' },
  }, ['seq', 'occurredAt', 'event', 'category', 'outcome', 'actorType', 'actorId', 'actorEmail', 'resourceType', 'resourceId', 'resourceLabel', 'hash']),

  WebhookEvent: obj({
    id: { type: 'string', description: 'The same on every retry: deduplicate on it (also the webhook-id header)' },
    type: { type: 'string', description: 'The audit event, e.g. user.invited' },
    timestamp: dateTime, tenantId: uuid,
    data: obj({
      actor: obj({ type: { type: 'string' }, id: nullable({ type: 'string' }), email: nullable({ type: 'string' }) }),
      resource: obj({ type: nullable({ type: 'string' }), id: nullable({ type: 'string' }), label: nullable({ type: 'string' }) }),
      outcome: { type: 'string' }, changes: {}, details: {}, requestId: nullable({ type: 'string' }),
    }),
  }),
};

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

export interface Endpoint {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Fastify style (/users/:id), without /v1 */
  path: string;
  operationId: string;
  tag: string;
  summary: string;
  /** The permission the API key needs */
  permission: string;
  query?: Record<string, Schema>;
  body?: Schema;
  /** Status → body schema (null: no body) */
  responses: Record<number, Schema | null>;
}

const idParam = 'id';
const page = { page: { type: 'integer', minimum: 1, default: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } };
const listOf = (key: string, item: string) => obj({ [key]: arrayOf(ref(item)), pagination: ref('Pagination') });

export const ENDPOINTS: Endpoint[] = [
  // Users
  { method: 'GET', path: '/users', operationId: 'listUsers', tag: 'Users', summary: 'List people (newest first)', permission: 'users:read',
    query: { ...page, limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 }, userType: { type: 'string', enum: USER_TYPES }, status: { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'PENDING'] }, search: { type: 'string', description: 'In email and name' } },
    responses: { 200: listOf('data', 'UserInList') } },
  { method: 'GET', path: '/users/:id', operationId: 'getUser', tag: 'Users', summary: 'One person', permission: 'users:read', responses: { 200: ref('User') } },
  { method: 'POST', path: '/users', operationId: 'inviteUser', tag: 'Users', summary: 'Invite someone: they set their own password from the emailed link', permission: 'users:create',
    body: obj({ email: { type: 'string', format: 'email' }, name: { type: 'string', minLength: 2 }, userType: { type: 'string', enum: USER_TYPES, default: 'TENANT_USER' } }, ['email', 'name']),
    responses: { 201: ref('UserInvited') } },
  { method: 'PATCH', path: '/users/:id', operationId: 'updateUser', tag: 'Users', summary: 'Rename, change type, deactivate or reactivate', permission: 'users:update',
    body: obj({ name: { type: 'string', minLength: 2 }, userType: { type: 'string', enum: USER_TYPES }, status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] } }, []),
    responses: { 200: ref('UserUpdated') } },
  { method: 'DELETE', path: '/users/:id', operationId: 'deleteUser', tag: 'Users', summary: 'Remove someone', permission: 'users:delete', responses: { 204: null } },

  // Groups
  { method: 'GET', path: '/groups', operationId: 'listGroups', tag: 'Groups', summary: 'List groups', permission: 'groups:read',
    query: { ...page, search: { type: 'string' }, status: { type: 'string', enum: ACTIVE_INACTIVE } }, responses: { 200: listOf('groups', 'GroupInList') } },
  { method: 'GET', path: '/groups/:id', operationId: 'getGroup', tag: 'Groups', summary: 'A group with its members', permission: 'groups:read', responses: { 200: ref('GroupDetail') } },
  { method: 'POST', path: '/groups', operationId: 'createGroup', tag: 'Groups', summary: 'Create a group', permission: 'groups:create',
    body: obj({ name: { type: 'string', minLength: 2, maxLength: 100 }, description: { type: 'string' }, groupType: { type: 'string', enum: ['MANUAL', 'SYNCED', 'RULE_BASED'], default: 'MANUAL' } }, ['name']),
    responses: { 201: ref('Group') } },
  { method: 'PATCH', path: '/groups/:id', operationId: 'updateGroup', tag: 'Groups', summary: 'Change a group', permission: 'groups:update',
    body: obj({ name: { type: 'string', minLength: 2, maxLength: 100 }, description: { type: 'string' }, status: { type: 'string', enum: ACTIVE_INACTIVE } }, []),
    responses: { 200: ref('Group') } },
  { method: 'DELETE', path: '/groups/:id', operationId: 'deleteGroup', tag: 'Groups', summary: 'Delete a group', permission: 'groups:delete', responses: { 204: null } },
  { method: 'POST', path: '/groups/:id/members', operationId: 'addGroupMember', tag: 'Groups', summary: 'Add someone to a group, optionally for a time', permission: 'groups:update',
    body: obj({ userId: uuid, validFrom: dateTime, validTo: dateTime }, ['userId']), responses: { 201: ref('GroupMembership') } },
  { method: 'DELETE', path: '/groups/:id/members/:userId', operationId: 'removeGroupMember', tag: 'Groups', summary: 'Remove someone from a group', permission: 'groups:update', responses: { 204: null } },

  // Organizations
  { method: 'GET', path: '/organizations', operationId: 'listOrganizations', tag: 'Organizations', summary: 'List organizations', permission: 'organizations:read',
    query: { ...page, search: { type: 'string' }, status: { type: 'string', enum: ACTIVE_INACTIVE } }, responses: { 200: listOf('organizations', 'OrganizationInList') } },
  { method: 'GET', path: '/organizations/:id', operationId: 'getOrganization', tag: 'Organizations', summary: 'An organization with its units and members', permission: 'organizations:read', responses: { 200: ref('OrganizationDetail') } },
  { method: 'POST', path: '/organizations', operationId: 'createOrganization', tag: 'Organizations', summary: 'Create an organization', permission: 'organizations:create',
    body: obj({ name: { type: 'string', minLength: 2, maxLength: 100 }, description: { type: 'string' } }, ['name']), responses: { 201: ref('Organization') } },
  { method: 'PATCH', path: '/organizations/:id', operationId: 'updateOrganization', tag: 'Organizations', summary: 'Change an organization', permission: 'organizations:update',
    body: obj({ name: { type: 'string', minLength: 2, maxLength: 100 }, description: { type: 'string' }, status: { type: 'string', enum: ACTIVE_INACTIVE } }, []),
    responses: { 200: ref('Organization') } },
  { method: 'DELETE', path: '/organizations/:id', operationId: 'deleteOrganization', tag: 'Organizations', summary: 'Delete an organization', permission: 'organizations:delete', responses: { 204: null } },
  { method: 'POST', path: '/organizations/:id/members', operationId: 'addOrganizationMember', tag: 'Organizations', summary: 'Add someone to an organization', permission: 'organizations:update',
    body: obj({ userId: uuid }, ['userId']), responses: { 201: ref('OrganizationMembership') } },
  { method: 'DELETE', path: '/organizations/:id/members/:userId', operationId: 'removeOrganizationMember', tag: 'Organizations', summary: 'Remove someone from an organization', permission: 'organizations:update', responses: { 204: null } },

  // Roles
  { method: 'GET', path: '/roles', operationId: 'listRoles', tag: 'Roles', summary: 'Roles and their permissions', permission: 'roles:read', responses: { 200: obj({ roles: arrayOf(ref('Role')) }) } },
  { method: 'GET', path: '/roles/assignments', operationId: 'listRoleAssignments', tag: 'Roles', summary: 'Who holds which role, where', permission: 'roles:read',
    responses: { 200: obj({ assignments: arrayOf(ref('RoleAssignmentInList')) }) } },
  { method: 'POST', path: '/roles/assign', operationId: 'assignRole', tag: 'Roles', summary: 'Give a role to a person or group, organization-wide or in one place, optionally for a time', permission: 'roles:assign',
    body: obj({
      roleId: uuid, principalType: { type: 'string', enum: ['USER', 'GROUP'] }, userId: uuid, groupId: uuid,
      scopeType: { type: 'string', enum: ['TENANT', 'ORGANIZATION', 'ORG_UNIT', 'RESOURCE'], default: 'TENANT' }, scopeId: { type: 'string' },
      validFrom: dateTime, validTo: dateTime,
    }, ['roleId', 'principalType']),
    responses: { 201: ref('RoleAssignment') } },
  { method: 'DELETE', path: '/roles/assignments/:id', operationId: 'removeRoleAssignment', tag: 'Roles', summary: 'Take a role away', permission: 'roles:assign', responses: { 204: null } },

  // Audit log
  { method: 'GET', path: '/audit', operationId: 'listAuditEntries', tag: 'Audit log', summary: 'The audit log, newest first', permission: 'audit:read',
    query: {
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 }, before: { type: 'integer', description: 'Entries before this seq (the previous page’s nextBefore)' },
      event: { type: 'string' }, category: { type: 'string' }, outcome: { type: 'string', enum: ['SUCCESS', 'FAILURE'] }, actorId: { type: 'string' },
      resourceType: { type: 'string' }, resourceId: { type: 'string' }, from: dateTime, to: dateTime, q: { type: 'string' },
    },
    responses: { 200: obj({ data: arrayOf(ref('AuditEntry')), nextBefore: nullable({ type: 'integer' }) }) } },
];

// ---------------------------------------------------------------------------
// The OpenAPI document
// ---------------------------------------------------------------------------

const openApiPath = (path: string) => path.replace(/:(\w+)/g, '{$1}');
const errors = {
  400: 'The request is not valid',
  401: 'No key, or a wrong, expired or revoked key (code INVALID_API_KEY, API_KEY_EXPIRED, API_KEY_REVOKED)',
  403: 'The key lacks the permission, a plan limit was reached (PLAN_LIMIT), or the organization is read-only (TRIAL_ENDED, PAYMENT_REQUIRED)',
  404: 'Not found in this organization',
  429: 'Too many requests',
};

export function openApiDocument(serverUrl = '/api/v1') {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const e of ENDPOINTS) {
    const p = openApiPath(e.path);
    const params = [...e.path.matchAll(/:(\w+)/g)].map(([, name]) => ({ name, in: 'path', required: true, schema: name === idParam || name.endsWith('Id') ? uuid : { type: 'string' } }));
    const query = Object.entries(e.query ?? {}).map(([name, schema]) => ({ name, in: 'query', required: false, schema }));
    const responses: Record<string, unknown> = {};
    for (const [status, schema] of Object.entries(e.responses)) {
      responses[status] = schema ? { description: 'OK', content: { 'application/json': { schema } } } : { description: 'Done (no content)' };
    }
    for (const [status, description] of Object.entries(errors)) {
      if (status === '404' && !e.path.includes(':')) continue;
      responses[status] = { description, content: { 'application/json': { schema: ref('Error') } } };
    }
    (paths[p] ??= {})[e.method.toLowerCase()] = {
      operationId: e.operationId,
      tags: [e.tag],
      summary: e.summary,
      description: `Needs the \`${e.permission}\` permission.`,
      'x-permission': e.permission,
      ...(params.length || query.length ? { parameters: [...params, ...query] } : {}),
      ...(e.body ? { requestBody: { required: true, content: { 'application/json': { schema: e.body } } } } : {}),
      responses,
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Multitenant API',
      version: '1',
      description: 'The organization’s API for other systems. Authenticate with an API key from the Developers page: `Authorization: Bearer mtk_…`. Within v1, things are only added: see docs/API_V1.md.',
    },
    servers: [{ url: serverUrl }],
    security: [{ apiKey: [] }],
    tags: ['Users', 'Groups', 'Organizations', 'Roles', 'Audit log'].map((name) => ({ name })),
    paths,
    webhooks: {
      event: {
        post: {
          summary: 'An event, sent to each webhook subscribed to its type (docs/API_ACCESS.md)',
          parameters: ['webhook-id', 'webhook-timestamp', 'webhook-signature'].map((name) => ({ name, in: 'header', required: true, schema: { type: 'string' } })),
          requestBody: { content: { 'application/json': { schema: ref('WebhookEvent') } } },
          responses: { 200: { description: 'Any 2xx within 10 seconds is taken; anything else is retried' } },
        },
      },
    },
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'An API key (mtk_…). X-API-Key also works.' } },
      schemas: SCHEMAS,
    },
  };
}
