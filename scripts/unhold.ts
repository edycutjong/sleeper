/**
 * The way out of a hold, from the command line.
 *
 *   npm run unhold -- --hold <uuid> --by <who> --note "<why>"
 *
 * Sleeper decides on behaviour, not on proof, so it will hold releases that turn out to be fine.
 * `commitUnhold` has always been the atomic counterpart to the hold — one transaction, four
 * writes, no DELETE — but until this script it had no caller outside the tests, which meant the
 * documented exit from a false positive was "write some TypeScript". A gate whose reversal is not
 * a command is a gate a distro cannot install.
 *
 * This runs as the **gate_svc** identity, the same one that committed the hold: clearing a hold
 * is an UPDATE on `release_hold` plus two appended rows, never a delete, so no extra privilege is
 * needed to undo what the agent did. See `scripts/provision.sh` step 4.
 *
 * What it prints is what actually changed — the transaction's own list of writes and the trust
 * status the package ended at — because "cleared" is a claim about rows, and an operator who just
 * un-blocked a release should be shown the rows rather than a checkmark.
 */
import { commitUnhold, holdEvidence } from '../src/memory.js'
import { closePool } from '../src/db.js'

const USAGE = 'Usage: npm run unhold -- --hold <release_hold uuid> --by <who> --note "<why>"'

function rule(title: string): void {
  console.log(`\n${'─'.repeat(78)}\n${title}\n${'─'.repeat(78)}`)
}

/** Same shape as `scripts/explain.ts`: no argument parser, so nothing to keep in sync with one. */
function flag(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`)
  if (at === -1) return null
  const value = process.argv[at + 1]
  // A flag whose value is the next flag is a typo, not an empty string — say so rather than
  // recording "--note" as the reason a release was let through.
  if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value.\n${USAGE}`)
  return value
}

async function main(): Promise<void> {
  const holdId = flag('hold')
  const by = flag('by')
  const note = flag('note')
  if (!holdId || !by || !note) {
    throw new Error(
      `--hold, --by and --note are all required — a cleared hold with no reviewer or reason ` +
        `named is exactly the audit gap this command exists to avoid.\n${USAGE}`,
    )
  }

  // Read before write. The operator is about to let a release through; showing which release,
  // and why it was stopped, is the last chance to notice that this is the wrong hold id.
  const before = await holdEvidence(holdId)
  if (!before) {
    throw new Error(`No release_hold with id ${holdId}. \`npm run explain\` lists what is held.`)
  }

  // Deliberately not titled "CLEARING" — nothing has been written yet, and the write below can
  // still be refused (a hold somebody else already resolved).
  rule(`HOLD ${before.hold.id} — ABOUT TO CLEAR`)
  console.log(`  package:  ${before.hold.packageId}`)
  console.log(`  version:  ${before.hold.releaseVersion}`)
  console.log(`  held at:  ${before.hold.createdAt.toISOString()}`)
  console.log(`  status:   ${before.trustStatus ?? 'unknown'}`)
  console.log(`  cleared by: ${by}`)
  console.log(`  reason:     ${note}`)
  console.log(`\n  Original hold reason:\n${before.hold.reason.replace(/^/gm, '    ')}`)

  const result = await commitUnhold(holdId, by, note)

  rule('WRITES COMMITTED (one transaction, all or nothing)')
  for (const write of result.writes) console.log(`  ${write}`)
  console.log(`\n  advisory id: ${result.advisoryId}   (a RETRACTION row — the first advisory stands)`)
  console.log(`  audit id:    ${result.auditId}`)
  console.log(`  resolved at: ${result.resolvedAt.toISOString()}`)

  rule(`TRUST STATUS FOR ${result.packageId}: ${result.trustStatus.toUpperCase()}`)
  if (result.trustStatus === 'held') {
    console.log('  Still held — another open hold covers this package, and clearing this one does')
    console.log('  not speak for that one. Clear it too before the package can release.')
  } else {
    console.log('  Cleared. The release may proceed, and the retraction advisory is queued for the')
    console.log('  distros that received the original.')
  }
  console.log(`\n  Full trail, including both halves:\n    npm run explain -- --hold ${holdId}`)
}

main()
  .catch((err) => {
    // Every failure this command has is an operator-facing sentence — an unknown hold id, a hold
    // somebody already resolved, a missing flag. A stack trace would bury all three.
    console.error(`\n${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  })
  .finally(closePool)
