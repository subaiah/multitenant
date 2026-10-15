// Tenant schema (kit + product models), for the shared tenant database.
// `npx prisma <command> --config prisma.tenant.config.ts`
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: './prisma/tenant',
  datasource: {
    url: env('TENANT_DATABASE_URL'),
    // Optional scratch database for `prisma migrate dev` and the CI drift check
    ...(process.env.TENANT_SHADOW_DATABASE_URL && { shadowDatabaseUrl: process.env.TENANT_SHADOW_DATABASE_URL }),
  },
});
