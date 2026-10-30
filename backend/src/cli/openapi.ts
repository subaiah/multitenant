/**
 * The API v1 contract (src/api/v1.ts) as files:
 *
 *   npm run openapi                       write docs/api/openapi-v1.json
 *   npm run openapi -- --check <file>     exit 1 if the contract breaks <file>
 *                                         (an earlier docs/api/openapi-v1.json; CI passes the base branch's)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openApiDocument } from '../api/v1.js';
import { breakingChanges } from '../api/compat.js';

export const SNAPSHOT = join(import.meta.dirname, '..', '..', '..', 'docs', 'api', 'openapi-v1.json');
const doc = openApiDocument();
const i = process.argv.indexOf('--check');
if (i > 0) {
  const base = JSON.parse(readFileSync(process.argv[i + 1], 'utf8'));
  const broken = breakingChanges(base, doc);
  if (broken.length) {
    console.error(`API v1 would break for its users:\n${broken.map((b) => `  - ${b}`).join('\n')}\nKeep v1 compatible (docs/API_V1.md); a breaking change needs a new version.`);
    process.exit(1);
  }
  console.log('API v1: compatible with', process.argv[i + 1]);
} else {
  writeFileSync(SNAPSHOT, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`Wrote ${SNAPSHOT}`);
}
