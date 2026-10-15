// Tenant schema (kit + product models), for the shared tenant database.
// `npx prisma <command> --config prisma.tenant.config.ts`
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: './prisma/tenant',
  datasource: {
    url: env('TENANT_DATABASE_URL'),
  },
});
