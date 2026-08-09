/**
 * The audit surface, from the command line.
 *
 *   npm run explain                    # re-run EXPLAIN on the prefix-scoped query, print the plan
 *   npm run explain -- --hold <uuid>   # "explain your hold" — the full evidence trail
 *
 * These are the same reads the Managed MCP Server exposes (`explain_query`, `select_query`,
 * `get_table_schema`), so a maintainer who cannot or will not wire up MCP can still audit a hold
 * with nothing but this repo and a connection string.
 */
import { config } from '../src/config.js'
import { explainScoped, holdEvidence, loadActorArc, scopedNeighbours } from '../src/memory.js'
import { closePool, query } from '../src/db.js'

function rule(title: string): void {
  console.log(`\n${'─'.repeat(78)}\n${title}\n${'─'.repeat(78)}`)
}

async function explainHold(holdId: string): Promise<void> {
  const evidence = await holdEvidence(holdId)
  if (!evidence) {
    console.error(`No release_hold with id ${holdId}. Run \`npm run replay\` first.`)
    process.exitCode = 1
    return
  }

  rule(`HOLD ${evidence.hold.id}`)
  console.log(`  package:   ${evidence.hold.packageId}`)
  console.log(`  version:   ${evidence.hold.releaseVersion}`)
  console.log(`  committed: ${evidence.hold.createdAt.toISOString()}`)
  console.log(`  similarity to nearest known takeover shape: ${evidence.hold.similarity.toFixed(4)}`)
  console.log(`  package trust status now: ${evidence.trustStatus ?? 'unknown'}`)

  rule('WHY')
  console.log(evidence.hold.reason.replace(/^/gm, '  '))

  if (evidence.matchedArc) {
    rule(`MATCHED PLAYBOOK ARC — ${evidence.matchedArc.packageId} (${evidence.matchedArc.label})`)
    console.log(`  source: ${evidence.matchedArc.source}`)
    console.log(`\n  ${evidence.matchedArc.arcSummary.replace(/\n/g, '\n  ')}`)
  }

  rule('DISTRO ADVISORIES QUEUED')
  for (const a of evidence.advisories) {
    console.log(`  [${a.sent ? 'sent' : 'queued'}] ${a.id}`)
    console.log(`  ${a.advisoryText.replace(/\n/g, '\n  ')}\n`)
  }

  rule('AUDIT TRAIL')
  for (const entry of evidence.auditTrail) {
    console.log(`  ${entry.createdAt.toISOString()}  ${entry.actor}  ${entry.action}`)
    if (entry.detail) {
      for (const part of entry.detail.split(' | ')) console.log(`      ${part}`)
    }
  }

  rule('THE SAME QUERY, VIA THE MANAGED MCP SERVER')
  console.log('  select_query:')
  console.log(
    `    SELECT h.release_version, h.similarity, h.reason, a.advisory_text\n` +
      `    FROM release_hold h JOIN distro_advisory_outbox a ON a.release_hold_id = h.id\n` +
      `    WHERE h.id = '${evidence.hold.id}';`,
  )
}

async function explainPlan(): Promise<void> {
  const arc = await loadActorArc(config.packageId, config.suspectActor)
  if (!arc) {
    console.error(
      `No actor_arcs row for ${config.packageId}/${config.suspectActor}. Run \`npm run replay\` first.`,
    )
    process.exitCode = 1
    return
  }

  rule(`PREFIX-SCOPED VECTOR SEARCH OVER ${config.packageId.toUpperCase()} MEMORY`)
  const explain = await explainScoped(config.packageId, arc.embedding)
  console.log(explain.plan.replace(/^/gm, '  '))
  console.log(`\n  vector index used:  ${explain.usedVectorIndex ? 'YES' : 'NO'}`)
  console.log(`  prefix-scoped:      ${explain.prefixScoped ? 'YES' : 'NO'}`)
  console.log(
    '\n  The `prefix spans` line is the proof: the ANN scan was bounded to this package\'s own\n' +
      '  history by the leading index column, not run across every package in the cluster.',
  )

  const counts = await query<{ package_id: string; n: string }>(
    'SELECT package_id, count(*) AS n FROM events GROUP BY package_id ORDER BY n DESC',
  )
  console.log('\n  events in memory, by package:')
  for (const row of counts.rows) console.log(`    ${row.package_id.padEnd(24)} ${row.n}`)

  rule('NEAREST EVENTS IN THIS PACKAGE\'S MEMORY')
  for (const n of await scopedNeighbours(config.packageId, arc.embedding, 10)) {
    console.log(
      `  ${n.similarity.toFixed(4)}  ${n.occurredAt.toISOString().slice(0, 10)} ` +
        `${n.actorId.padEnd(14)} [${n.kind}] ${n.content.slice(0, 48)}…`,
    )
  }
}

async function main(): Promise<void> {
  const holdFlag = process.argv.indexOf('--hold')
  if (holdFlag !== -1) {
    const id = process.argv[holdFlag + 1]
    if (!id) throw new Error('Usage: npm run explain -- --hold <release_hold uuid>')
    await explainHold(id)
    return
  }
  await explainPlan()
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(closePool)
