/**
 * Phase 0 spike — proves the retrieval mechanic end-to-end against the real xz timeline,
 * with no UI and no agent loop. This is the go/no-go for the whole project.
 *
 *   npm run spike
 *
 * It passes only if all three of these hold:
 *   1. EXPLAIN on the per-package query shows `prefix spans` — the vector index really is
 *      pre-filtered to one package's own history rather than scanning globally.
 *   2. The reconstructed xz actor arc's nearest playbook neighbours are `takeover` arcs.
 *   3. Held-out takeover arcs separate from held-out benign arcs by a visible margin.
 *
 * (3) is measured only on arcs in `heldout`, which are never inserted into the playbook.
 * The xz timeline is the demo, not the metric — see DEMO.md.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { config } from '../src/config.js'
import { embed, converse } from '../src/bedrock.js'
import { closePool, query, toVector } from '../src/db.js'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = join(here, '..', 'data')

type TimelineEvent = {
  actor_id: string
  kind: string
  occurred_at: string
  content: string
  source_url?: string
}
type Timeline = {
  package_id: string
  actors: Record<string, string>
  events: TimelineEvent[]
}
type Arc = { id: string; label: string; arc_summary: string }
type Synthetic = { playbook: Arc[]; heldout: Arc[] }

const timeline: Timeline = JSON.parse(readFileSync(join(dataDir, 'xz-timeline.json'), 'utf8'))
const synthetic: Synthetic = JSON.parse(readFileSync(join(dataDir, 'synthetic-arcs.json'), 'utf8'))

/** The event Sleeper must hold on: the 5.6.0 tarball going out. */
const DECISION_AT = new Date('2024-02-24T00:00:00Z')
const SUSPECT_ACTOR = 'jia-tan'

const DAY_MS = 86_400_000

function section(title: string): void {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`)
}

async function ingestEvents(): Promise<void> {
  section('1. Ingesting the real xz-utils timeline')
  await query('DELETE FROM events WHERE package_id = $1', [timeline.package_id])

  for (const [i, event] of timeline.events.entries()) {
    const embedding = await embed(event.content)
    await query(
      `INSERT INTO events (package_id, actor_id, kind, content, occurred_at, source_url, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7::VECTOR)`,
      [
        timeline.package_id,
        event.actor_id,
        event.kind,
        event.content,
        event.occurred_at,
        event.source_url ?? null,
        toVector(embedding),
      ],
    )
    process.stdout.write(
      `\r  ${i + 1}/${timeline.events.length} events embedded and written to CockroachDB`,
    )
  }
  console.log()
}

/**
 * Builds the actor arc as of the decision point.
 *
 * The 90-day window bounds the *recent detail*; the summary also carries the cumulative
 * trajectory (tenure, privilege escalations), because a 90-day slice of the xz timeline is
 * three innocuous commits — the whole premise is that the signal lives in the multi-year arc.
 */
async function buildActorArc(): Promise<{ summary: string; embedding: number[] }> {
  section(`2. Building the ${config.arcWindowDays}-day actor arc for "${SUSPECT_ACTOR}"`)

  const windowStart = new Date(DECISION_AT.getTime() - config.arcWindowDays * DAY_MS)

  const all = timeline.events.filter(
    (e) => e.actor_id === SUSPECT_ACTOR && new Date(e.occurred_at) <= DECISION_AT,
  )
  const recent = all.filter((e) => new Date(e.occurred_at) >= windowStart)
  const firstSeen = all[0]!.occurred_at.slice(0, 10)
  const tenureDays = Math.round((DECISION_AT.getTime() - new Date(all[0]!.occurred_at).getTime()) / DAY_MS)

  console.log(`  cumulative events: ${all.length}   in window: ${recent.length}`)
  console.log(`  first seen: ${firstSeen}   tenure at decision point: ${tenureDays} days`)

  const prompt = [
    `Package: ${timeline.package_id}`,
    `Actor: ${SUSPECT_ACTOR}`,
    `First public activity: ${firstSeen} (${tenureDays} days before this assessment)`,
    `Privilege changes on record: ${all.filter((e) => e.kind === 'maintainer_change').length}`,
    `Releases produced by this actor: ${all.filter((e) => e.kind === 'release').length}`,
    '',
    `Recent activity (last ${config.arcWindowDays} days):`,
    ...recent.map((e) => `- ${e.occurred_at.slice(0, 10)} [${e.kind}] ${e.content}`),
    '',
    'Full trajectory:',
    ...all.map((e) => `- ${e.occurred_at.slice(0, 10)} [${e.kind}] ${e.content}`),
  ].join('\n')

  const summary = await converse(
    'You summarise an open-source contributor\'s behavioural arc for a supply-chain risk system. ' +
      'Write one dense paragraph describing the SHAPE of the trajectory: how the actor entered the ' +
      'project, how trust escalated and how fast, what kinds of change they concentrated on, and ' +
      'what other accounts did around them. Describe behaviour, not verdicts — do not say whether ' +
      'this is an attack, and do not name the package or any real person.',
    prompt,
  )

  console.log(`\n  arc summary:\n  ${summary.replace(/\n/g, '\n  ')}\n`)

  const embedding = await embed(summary)
  await query('DELETE FROM actor_arcs WHERE package_id = $1 AND actor_id = $2', [
    timeline.package_id,
    SUSPECT_ACTOR,
  ])
  await query(
    `INSERT INTO actor_arcs
       (package_id, actor_id, window_start, window_end, event_count, arc_summary, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7::VECTOR)`,
    [
      timeline.package_id,
      SUSPECT_ACTOR,
      windowStart.toISOString(),
      DECISION_AT.toISOString(),
      recent.length,
      summary,
      toVector(embedding),
    ],
  )

  return { summary, embedding }
}

async function seedPlaybook(): Promise<void> {
  section('3. Seeding the takeover playbook (retrieval corpus)')
  await query('DELETE FROM takeover_playbook')

  for (const arc of synthetic.playbook) {
    const embedding = await embed(arc.arc_summary)
    await query(
      `INSERT INTO takeover_playbook
         (package_id, label, source, held_out, arc_summary, embedding)
       VALUES ($1, $2, 'synthetic', false, $3, $4::VECTOR)`,
      [arc.id, arc.label, arc.arc_summary, toVector(embedding)],
    )
  }
  console.log(`  ${synthetic.playbook.length} synthetic reference arcs inserted`)
  console.log(`  ${synthetic.heldout.length} held-out arcs deliberately NOT inserted`)
}

async function provePrefixScoping(arcEmbedding: number[]): Promise<boolean> {
  section('4. Proving the vector index is prefix-scoped (the "memory layer at work" shot)')

  const sql = `SELECT id, content FROM events
               WHERE package_id = $1
               ORDER BY embedding <=> $2::VECTOR
               LIMIT 20`
  const params = [timeline.package_id, toVector(arcEmbedding)]

  const explain = await query<{ info: string }>(`EXPLAIN ${sql}`, params)
  const plan = explain.rows.map((r) => r.info).join('\n')
  console.log(plan.replace(/^/gm, '  '))

  const scoped = /prefix spans/i.test(plan)
  console.log(`\n  prefix spans present: ${scoped ? 'YES' : 'NO'}`)
  return scoped
}

async function matchAgainstPlaybook(
  label: string,
  embedding: number[],
  limit = 5,
): Promise<{ label: string; similarity: number }[]> {
  const result = await query<{ id: string; label: string; package_id: string; distance: string }>(
    `SELECT id, label, package_id, embedding <=> $1::VECTOR AS distance
     FROM takeover_playbook
     ORDER BY embedding <=> $1::VECTOR
     LIMIT ${limit}`,
    [toVector(embedding)],
  )
  const matches = result.rows.map((r) => ({
    label: r.label,
    similarity: 1 - Number(r.distance),
  }))
  console.log(`  ${label}`)
  for (const [i, row] of result.rows.entries()) {
    console.log(
      `    ${i + 1}. ${row.package_id.padEnd(18)} ${row.label.padEnd(9)} ` +
        `similarity ${(1 - Number(row.distance)).toFixed(4)}`,
    )
  }
  return matches
}

async function evaluateHeldOut(): Promise<{ takeover: number; benign: number; margin: number }> {
  section('6. Held-out separation (never inserted into the playbook, never used for tuning)')

  const scores: Record<string, number[]> = { takeover: [], benign: [] }

  for (const arc of synthetic.heldout) {
    const embedding = await embed(arc.arc_summary)
    const matches = await matchAgainstPlaybook(`${arc.id} (${arc.label})`, embedding, 3)
    // Score an arc by its single nearest takeover neighbour — the decision the agent
    // actually makes is "does this look like a known takeover shape?"
    const nearestTakeover = matches.filter((m) => m.label === 'takeover')[0]?.similarity ?? 0
    scores[arc.label]!.push(nearestTakeover)
  }

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  const takeover = mean(scores.takeover!)
  const benign = mean(scores.benign!)

  console.log(`\n  mean nearest-takeover similarity`)
  console.log(`    held-out takeover arcs: ${takeover.toFixed(4)}`)
  console.log(`    held-out benign arcs:   ${benign.toFixed(4)}`)
  console.log(`    margin:                 ${(takeover - benign).toFixed(4)}`)

  return { takeover, benign, margin: takeover - benign }
}

async function main(): Promise<void> {
  console.log(`Sleeper spike — package "${timeline.package_id}", region ${config.aws.region}`)
  console.log(`embedding model: ${config.aws.embeddingModelId}`)
  console.log(`chat model:      ${config.aws.chatModelId}`)

  await ingestEvents()
  const arc = await buildActorArc()
  await seedPlaybook()
  const scoped = await provePrefixScoping(arc.embedding)

  section('5. Matching the real xz arc against the playbook (unscoped)')
  const xzMatches = await matchAgainstPlaybook('xz-utils / jia-tan arc', arc.embedding)
  const topIsTakeover = xzMatches[0]?.label === 'takeover'

  const heldOut = await evaluateHeldOut()

  section('KILL-CRITERIA VERDICT')
  const checks = [
    ['EXPLAIN shows prefix spans', scoped],
    ['xz arc\'s nearest playbook neighbour is a takeover arc', topIsTakeover],
    ['held-out takeover/benign margin is positive and visible', heldOut.margin > 0.02],
  ] as const

  for (const [name, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)

  const allPassed = checks.every(([, ok]) => ok)
  console.log(
    allPassed
      ? '\nSpike PASSED — the mechanic separates. Proceed to Phase 1.'
      : '\nSpike FAILED — see build-plan.md kill criteria before spending another day on this.',
  )
  process.exitCode = allPassed ? 0 : 1
}

main()
  .catch((err) => {
    console.error('\n', err)
    process.exitCode = 1
  })
  .finally(closePool)
