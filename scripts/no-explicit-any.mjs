// The frontend has no explicit `any`: a value from the API gets a type (or
// `unknown`) so the compiler checks what's done with it. Run by `npm run typecheck`.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const files = readdirSync('src', { recursive: true, encoding: 'utf8' }).filter((f) => /\.(ts|tsx)$/.test(f));
const found = [];
for (const file of files) {
  readFileSync(join('src', file), 'utf8').split('\n').forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '').replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
    if (/(:\s*any\b|<any>|\bas any\b|any\[\]|<any,|,\s*any>)/.test(code)) found.push(`src/${file}:${i + 1}: ${line.trim()}`);
  });
}
if (found.length) {
  console.error(`Explicit \`any\` in the frontend (give it a type, or \`unknown\`):\n${found.join('\n')}`);
  process.exit(1);
}
