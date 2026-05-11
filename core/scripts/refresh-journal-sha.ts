#!/usr/bin/env tsx
/**
 * Reconcile drizzle journal SHA drift between disk and migrations_meta.
 *
 * Boot's drift check (core/src/index.ts) refuses to start in production when
 * the SHA-256 of meta/_journal.json doesn't match the value stored in
 * migrations_meta(id='journal'). The most common benign cause is a
 * renumber-only commit on disk: _journal.json content shifts but no new
 * migration runs, so the post-migrate refresh in run-migrations.ts is
 * skipped (newCount stays 0) and the recorded SHA goes stale.
 *
 * This script is the safe out for that case. Run on the booting environment
 * (so it sees the same disk SHA the failing app sees), against the same
 * DATABASE_URL the app uses. Default is dry-run — pass `--apply` to write.
 *
 *     pnpm --filter @robin/core refresh-journal-sha           # report only
 *     pnpm --filter @robin/core refresh-journal-sha --apply   # write
 *
 * Always confirm dryRun output names the diskSha you expect before applying.
 * If the schema itself looks wrong, do NOT apply — the drift may be real.
 */

import 'dotenv/config'
import { checkAndUpdateJournalDrift, updateJournalSha } from '../src/bootstrap/run-migrations.js'
import { logger } from '../src/lib/logger.js'

const log = logger.child({ component: 'refresh-journal-sha' })

async function main() {
  const apply = process.argv.includes('--apply')

  const result = await checkAndUpdateJournalDrift()

  if (result.kind === 'unavailable') {
    log.error('could not read drizzle/migrations/meta/_journal.json — aborting')
    process.exit(1)
  }

  if (result.kind === 'seeded') {
    log.info({ diskSha: result.diskSha }, 'no migrations_meta row existed — seeded with disk SHA')
    process.exit(0)
  }

  if (result.kind === 'match') {
    log.info({ sha: result.sha }, 'no drift — disk SHA already matches migrations_meta')
    process.exit(0)
  }

  // result.kind === 'drift'
  log.warn(
    { diskSha: result.diskSha, dbSha: result.dbSha, apply },
    apply
      ? 'drift detected — applying disk SHA to migrations_meta'
      : 'drift detected — dry run, pass --apply to reconcile',
  )

  if (!apply) process.exit(0)

  await updateJournalSha()
  log.info({ diskSha: result.diskSha }, 'migrations_meta journal SHA updated to disk value')
  process.exit(0)
}

main().catch((err) => {
  log.fatal({ err }, 'refresh-journal-sha failed')
  process.exit(1)
})
