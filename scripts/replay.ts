/**
 * Terminal replay of the real xz-utils timeline — the same agent loop the demo UI drives.
 *
 *   npm run replay
 *
 * This is the ground-truth hero demo, not a benchmark. It replays the public CVE-2024-3094
 * timeline event by event and shows the gate closing at the 5.6.0 tarball. Quality numbers come
 * from `npm run bench`, on held-out data, and are reported separately.
 */
import { config } from '../src/config.js'
import { loadThresholds, loadTimeline } from '../src/corpus.js'
import { OFFLINE, providerBanner } from '../src/embeddings.js'
import { runReplay, type Step } from '../src/agent.js'
import { closePool } from '../src/db.js'

const DAY_MS = 86_400_000
/** Andres Freund's oss-security disclosure — the real-world catch, 35 days after 5.6.0 shipped. */
const REAL_WORLD_CATCH = new Date('2024-03-29T00:00:00Z')

function rule(title: string): void {
  console.log(`\n${'─'.repeat(78)}\n${title}\n${'─'.repeat(78)}`)
}

function render(step: Step): void {
  switch (step.type) {
    case 'log':
      console.log(step.message)
      break

    case 'event': {
      const date = step.event.occurredAt.slice(0, 10)
      const marker = step.afterHold ? '·' : '+'
      console.log(
        `  ${marker} [${String(step.index + 1).padStart(2)}/${step.total}] ${date} ` +
          `${step.event.kind.padEnd(17)} ${step.event.actorId.padEnd(14)} ` +
          `${step.event.content.slice(0, 60)}…  (${step.latencyMs}ms)`,
      )
      break
    }

    case 'arc':
      rule(`ACTOR ARC — ${step.actorId}`)
      console.log(
        `  window ${step.windowStart.slice(0, 10)} → ${step.windowEnd.slice(0, 10)}  ` +
          `(${step.windowEventCount} events in window, ${step.cumulativeEvents} cumulative)`,
      )
      console.log(`\n  ${step.summary.replace(/\n/g, '\n  ')}\n`)
      console.log('  Structural evidence held in memory:')
      for (const line of step.evidence) console.log(`    - ${line}`)
      break

    case 'explain':
      rule('PREFIX-SCOPED VECTOR SEARCH — EXPLAIN (the memory layer at work)')
      console.log(step.explain.plan.replace(/^/gm, '  '))
      console.log(
        `\n  vector index used: ${step.explain.usedVectorIndex ? 'YES' : 'NO'}   ` +
          `prefix-scoped to this package: ${step.explain.prefixScoped ? 'YES' : 'NO'}`,
      )
      console.log('\n  Nearest events in this package\'s own memory:')
      for (const n of step.neighbours) {
        console.log(
          `    ${n.similarity.toFixed(4)}  ${n.occurredAt.toISOString().slice(0, 10)} ` +
            `[${n.kind}] ${n.content.slice(0, 54)}…`,
        )
      }
      break

    case 'match':
      rule('UNSCOPED PLAYBOOK MATCH')
      for (const [i, m] of step.matches.entries()) {
        console.log(
          `  ${i + 1}. ${m.packageId.padEnd(20)} ${m.label.padEnd(9)} ` +
            `similarity ${m.similarity.toFixed(4)}`,
        )
      }
      break

    case 'decision':
      rule(`DECISION — release ${step.releaseVersion}`)
      console.log(`  ${step.decision.hold ? 'HOLD' : 'ALLOW'}  (${step.latencyMs}ms from ingest)`)
      console.log(`  ${step.decision.explanation}`)
      console.log(
        `  thresholds: holdAt ${step.decision.thresholds.holdAt} / ` +
          `minMargin ${step.decision.thresholds.minMargin}`,
      )
      break

    case 'hold':
      rule(`HELD — release ${step.releaseVersion}`)
      console.log(`  release_hold id: ${step.holdId}`)
      console.log(`  committed at:    ${step.committedAt}  (${step.latencyMs}ms from ingest)`)
      console.log(`  ONE transaction, ${step.writes.length} writes:`)
      for (const w of step.writes) console.log(`    - ${w}`)
      console.log(`\n  Rationale:\n  ${step.reason.replace(/\n/g, '\n  ')}`)
      console.log(`\n  Distro advisory:\n  ${step.advisory.replace(/\n/g, '\n  ')}`)
      break
  }
}

async function main(): Promise<void> {
  const timeline = loadTimeline(config.packageId)
  const { thresholds, calibrated } = loadThresholds()

  console.log(`Sleeper replay — ${timeline.packageId}`)
  console.log(providerBanner())
  console.log(
    calibrated
      ? `thresholds: calibrated (${calibrated.fittedOn}) holdAt=${thresholds.holdAt.toFixed(4)} minMargin=${thresholds.minMargin.toFixed(4)}`
      : `thresholds: UNCALIBRATED fallback holdAt=${thresholds.holdAt} minMargin=${thresholds.minMargin} — run \`npm run calibrate\``,
  )

  rule('INGESTING THE PUBLIC xz-utils TIMELINE INTO COCKROACHDB')
  const summary = await runReplay(
    {
      packageId: timeline.packageId,
      suspectActor: config.suspectActor,
      windowDays: config.arcWindowDays,
      thresholds,
      events: timeline.events,
    },
    render,
  )

  rule('OUTCOME')
  console.log(`  events ingested:  ${summary.ingested}`)
  console.log(`  prefix-scoped:    ${summary.prefixScoped ? 'proven by EXPLAIN' : 'NOT PROVEN'}`)

  if (summary.holdId && summary.heldAt) {
    const daysEarlier = Math.round(
      (REAL_WORLD_CATCH.getTime() - new Date(summary.heldAt).getTime()) / DAY_MS,
    )
    console.log(`  release held:     ${summary.releaseVersion} on ${summary.heldAt.slice(0, 10)}`)
    console.log(`  hold id:          ${summary.holdId}`)
    console.log(`  decision latency: ${summary.decisionLatencyMs}ms from the release event landing`)
    console.log(
      `\n  The real world found this backdoor on 2024-03-29, ${daysEarlier} days later, because` +
        `\n  one engineer investigated 500ms of unexplained sshd login latency.`,
    )
    console.log(`\n  Inspect the hold:  npm run explain -- --hold ${summary.holdId}`)
  } else if (OFFLINE) {
    console.log('  release held:     NO — expected in offline mode.')
    console.log(
      '\n  The offline stand-in is a hashed bag-of-words, which carries no sense of what a\n' +
        '  takeover arc means, so it cannot separate one from an ordinary contributor. This run\n' +
        '  proves the wiring — ingest, arc rollup, prefix-scoped ANN, decision path — not the\n' +
        '  detection. Unset SLEEPER_OFFLINE and re-run against Bedrock for the real replay.',
    )
  } else {
    console.log('  release held:     NO — the gate stayed open.')
    console.log(
      '\n  If this is unexpected: check `npm run calibrate` has been run, and that the playbook\n' +
        '  is seeded (`npm run seed`).',
    )
    process.exitCode = 1
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(closePool)
