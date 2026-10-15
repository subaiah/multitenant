// Control-plane schema (platform users, tenants, connection details).
// `npx prisma <command>` uses this config by default.
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: './prisma/control/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
    // Optional scratch database for `prisma migrate dev` and the CI drift check
    ...(process.env.SHADOW_DATABASE_URL && { shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL }),
  },
});
