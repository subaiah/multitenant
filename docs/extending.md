# Building a product on the kit

This repository is a starter kit. Each product forks it and adds its own features.

The kit is the same in every product. It covers:

- tenants
- sign-in
- users, groups, roles and access reviews
- organizations
- the platform and tenant portals

A product's own code sits behind a few extension points. Keep it there, and kit updates will merge into your fork without conflicts.

| What | Where |
| --- | --- |
| Tenant tables | `backend/prisma/tenant/product/*.prisma` |
| Permissions, API, menu, per-tenant seed | `backend/src/product/index.ts` (the `ProductModule`, defined in `backend/src/kit/product.ts`) |
| Screens | `src/product/` in the frontend, plus routes in `src/App.tsx` |

Don't edit the kit's own files (`prisma/control`, `prisma/tenant/kit`, `src/routes`, `src/lib`) for product features. If you need a hook the kit doesn't offer, add it to the kit in a general way and send it upstream.

## Where data lives

There are two databases, each with its own Prisma schema and client.

**The control plane** (`prisma/control`, `DATABASE_URL`) holds:

- platform users
- tenants and how to reach each tenant's data
- the app catalogue, menus and support sessions

A product never adds tables here.

**The tenant plane** (`prisma/tenant`) holds everything a tenant owns:

- the kit's tables in `kit/`
- your tables in `product/`

The same schema is used whether a tenant has shared tables, its own schema or its own database. Tenant migrations run against every tenant location. See [tenant-isolation.md](tenant-isolation.md).

In a route, always use `request.db`. It is the current tenant's client, connected as the tenant's own database role, so row-level security limits it to that tenant's rows. Outside a request, get a tenant's client with `await dbForTenant(tenantId)`.

## Rules for product tables

Every model in `prisma/tenant/product/` must follow these rules:

- **A `tenantId String @map("tenant_id")` column.** Row-level security checks it, and it lets data move between isolation modes.
- **No relations to control-plane models** (tenants, platform users). Store plain ids.
- **`tenantId` in every unique constraint on a value people choose**, such as `@@unique([tenantId, number])`. Random values (tokens, uuids) can stay globally unique.
- **Filter every query by `tenantId`**, even though the database also enforces it.
- **Raw SQL names no schema.** A schema-mode tenant's tables live in its own schema, and its role's default `search_path` finds them. Use unqualified table names in `request.db.$queryRaw`, and the same SQL works in every mode.

Row-level security is added for you. Once your migration is applied, `npm run tenant:migrate` enables and forces it on every table with a `tenant_id` column, and adds the policy. `test/isolation.test.ts` fails if any tenant table lacks it.

## Example: invoices

### 1. The table

`backend/prisma/tenant/product/invoices.prisma`:

```prisma
model Invoice {
  id        String   @id @default(uuid())
  tenantId  String   @map("tenant_id")
  number    String
  customer  String
  amount    Decimal  @db.Decimal(12, 2)
  status    String   @default("DRAFT")
  createdAt DateTime @default(now()) @map("created_at")

  @@unique([tenantId, number])
  @@index([tenantId, status])
  @@map("invoices")
}
```

Then run `npm run prisma:generate`. Create a tenant migration with `npm run prisma:migrate:tenant`.

### 2. The product module

`backend/src/product/index.ts`:

```ts
import type { ProductModule } from '../kit/product.js';
import { invoiceRoutes } from './invoices.js';

export const product: ProductModule = {
  name: 'Invoicing',
  permissions: [
    { name: 'invoices:read', description: 'See invoices' },
    { name: 'invoices:manage', description: 'Create, send and cancel invoices' },
  ],
  resources: {
    invoices: { label: 'Invoices', description: 'Bills sent to customers' },
  },
  // On top of the kit's defaults; the built-in roles pick these up too
  userTypeGrants: {
    TENANT_ADMIN: ['invoices:*'],
    TENANT_MANAGER: ['invoices:*'],
    TENANT_USER: ['invoices:read'],
  },
  routes: invoiceRoutes,
  tenantMenu: [
    { label: 'Invoices', path: '/invoices', icon: 'Receipt', permission: 'invoices:read' },
  ],
  async onTenantCreated(tenantId, db) {
    // Seed per-tenant product data here (runs once, when the tenant is created)
  },
};
```

Product permissions must use resources of their own. The server refuses to start if one reuses a kit resource such as `users:export`, or a platform resource. That stops a product from quietly widening what kit roles grant.

Once declared, product permissions appear in the role editor and in access reviews. Tenant admins can then put them in their own roles.

### 3. Routes

`backend/src/product/invoices.ts`:

```ts
import type { FastifyPluginAsync } from 'fastify';
import { logActivity } from '../lib/activity.js';

export const invoiceRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/invoices', { config: { permission: 'invoices:read' } }, async (request) => {
    return request.db.invoice.findMany({
      where: { tenantId: request.tenant.id },
      orderBy: { createdAt: 'desc' },
    });
  });

  fastify.post('/invoices', { config: { permission: 'invoices:manage' } }, async (request, reply) => {
    const body = request.body as { number: string; customer: string; amount: number };
    const invoice = await request.db.invoice.create({ data: { ...body, tenantId: request.tenant.id } });
    await logActivity({
      tenantId: request.tenant.id,
      userId: request.user.userId,
      action: 'created invoice',
      target: invoice.number,
      type: 'USER',
    });
    return reply.status(201).send(invoice);
  });
};
```

Product routes are registered inside the authenticated scope. Every request there already has:

- a verified session
- `request.tenant`
- `request.user`
- `request.db`

Every route must declare `config: { permission }`. The route-permission test fails on any route that doesn't.

### 4. Menu and screens

The `tenantMenu` entries go right after Dashboard in the tenant sidebar; the release step (`npm run migrate`) adds them, as does `npm run prisma:seed-menus`. Users only see the entries their permissions allow. A group of entries can sit under a heading: give the heading a path starting with `#` (`{ label: 'Billing', path: '#billing', icon: 'Package', children: [...] }`); it shows only when someone may open at least one of its entries.

Add the page under `src/product/` in the frontend, and its route in `src/App.tsx` behind the same permission.

## What the kit calls, and when

| Hook | Called |
| --- | --- |
| `permissions`, `resources`, `userTypeGrants` | at startup; merged into the catalogue in `src/utils/permissions.ts` |
| `routes` | at startup, inside the authenticated, tenant-bound scope |
| `tenantMenu` | at the release step, and when menus are seeded |
| `onTenantCreated` | when a platform admin creates a tenant, after the kit's defaults (sign-in settings, built-in roles) |
