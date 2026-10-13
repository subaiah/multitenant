import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';
import { config } from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env file
config({ path: path.resolve(__dirname, '.env') });

export default defineConfig({
  schema: path.join(__dirname, 'prisma', 'schema.prisma'),
  datasource: {
    url: process.env.DATABASE_URL || '',
  },
});
