/**
 * Audit log maintenance from the command line (lib/audit.ts).
 *
 *   npm run audit:archive             archive entries past AUDIT_RETENTION_DAYS (every log)
 *   npm run audit:verify              check every log's chain, archives included
 *   npm run audit:verify -- <chain>   one log: "platform" or a tenant id
 */
import { controlDb, disconnectDatabases } from '../lib/prisma.js';
import { PLATFORM_CHAIN, archiveExpired, verifyChain } from '../lib/audit.js';

const [command, only] = process.argv.slice(2);
let failed = false;
try {
  if (command === 'archive') {
    for (const r of await archiveExpired()) {
      if (r.skipped) failed = true;
      console.log(`${r.skipped ? 'skip' : 'ok  '}  ${r.chain}: ${r.archived} archived${r.file ? ` → ${r.file}` : ''}${r.skipped ? ` (${r.skipped})` : ''}`);
    }
  } else if (command === 'verify') {
    const tenants = await controlDb.tenant.findMany({ where: { provisioningStatus: 'READY' }, select: { id: true, slug: true } });
    const chains = only ? [only] : [PLATFORM_CHAIN, ...tenants.map((t) => t.id)];
    for (const chain of chains) {
      const r = await verifyChain(chain);
      const name = chain === PLATFORM_CHAIN ? 'platform' : (tenants.find((t) => t.id === chain)?.slug ?? chain);
      console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${name}: ${r.entries} live, ${r.archivedEntries} archived in ${r.archives} file(s)`);
      for (const p of r.problems) console.log(`        ${p.seq ? `#${p.seq} ` : ''}${p.problem}`);
      if (!r.ok) failed = true;
    }
  } else {
    console.error('Usage: audit archive | verify [chain]');
    failed = true;
  }
} finally {
  await disconnectDatabases();
}
process.exit(failed ? 1 : 0);
