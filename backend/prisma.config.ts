// Control-plane schema (platform users, tenants, connection details).
// `npx prisma <command>` uses this config by default.
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: './prisma/control/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
});
