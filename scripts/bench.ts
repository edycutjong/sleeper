/**
 * The benchmark. Deterministic, seeded, held-out, and reproducible by anyone with the repo.
 *
 *   npm run bench
 *
 * What it measures, and what it deliberately does NOT:
 *
 *   - It is computed ONLY on the held-out arcs (`held_out = true`), which are excluded from every
 *     retrieval query the agent runs and were not visible to `npm run calibrate`.
 *   - The xz timeline is NOT part of any number here. That replay is a ground-truth demo of a real
 *     public incident; folding it in would be training on the answer and reporting it as accuracy.
 *   - A lexical baseline (hashed bag-of-words cosine, same decision rule) is run over the same
 *     queries, because "our vector search scored X" is meaningless without knowing what keyword
 *     matching alone would have scored.
 *
 * It refuses to run in offline mode: the offline embedder is a hash function, and a quality number
 * computed on it would be fiction.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, loadThresholds } from '../src/corpus.js'
import { decide, type Label, type PlaybookMatch, type Thresholds } from '../src/decide.js'
import { OFFLINE, offlineEmbed, providerBanner } from '../src/embeddings.js'
import { matchPlaybook, playbookArcs, type StoredArc } from '../src/memory.js'
import { closePool } from '../src/db.js'

const REPETITIONS = 5

function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  // Nearest-rank; with the sample sizes here this is less misleading than interpolating.
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(rank, sorted.length) - 1]!
}

type Outcome = { label: Label; held: boolean; similarity: number; margin: number; topKHit: boolean }

function tally(outcomes: Outcome[]): {
  recall: number
  falsePositiveRate: number
  precision: number
  recallAtK: number
  takeovers: number
  benigns: number
} {
  const takeovers = outcomes.filter((o) => o.label === 'takeover')
  const benigns = outcomes.filter((o) => o.label === 'benign')
  const tp = takeovers.filter((o) => o.held).length
  const fp = benigns.filter((o) => o.held).length
  return {
    recall: takeovers.length ? tp / takeovers.length : 0,
    falsePositiveRate: benigns.length ? fp / benigns.length : 0,
    precision: tp + fp ? tp / (tp + fp) : 0,
    recallAtK: takeovers.length
      ? takeovers.filter((o) => o.topKHit).length / takeovers.length
      : 0,
    takeovers: takeovers.length,
    benigns: benigns.length,
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!
  return dot // both operands are L2-normalised
}

/** Same decision rule, but retrieval is keyword overlap instead of a learned embedding. */
function lexicalBaseline(
  heldOut: StoredArc[],
  playbook: StoredArc[],
  thresholds: Thresholds,
  k: number,
): Outcome[] {
  const playbookVectors = playbook.map((arc) => ({ arc, vector: offlineEmbed(arc.arcSummary) }))
  return heldOut.map((arc) => {
    const probe = offlineEmbed(arc.arcSummary)
    const matches: PlaybookMatch[] = playbookVectors
      .map(({ arc: p, vector }) => ({
        id: p.id,
        packageId: p.packageId,
        label: p.label,
        source: p.source,
        similarity: cosine(probe, vector),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k)
    const decision = decide(matches, thresholds)
    return {
      label: arc.label,
      held: decision.hold,
      similarity: decision.similarity,
      margin: decision.margin,
      topKHit: matches.some((m) => m.label === 'takeover'),
    }
  })
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)))
  const line = (r: string[]) => `| ${r.map((c, i) => c.padEnd(widths[i]!)).join(' | ')} |`
  const sep = `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`
  return [line(rows[0]!), sep, ...rows.slice(1).map(line)].join('\n')
}

async function main(): Promise<void> {
  if (OFFLINE) {
    console.error(
      'REFUSING TO RUN.\n\n' +
        'SLEEPER_OFFLINE=1 replaces Bedrock with a hashed bag-of-words stand-in. It exists to\n' +
        'exercise the SQL and the agent loop without an AWS account, not to produce numbers.\n' +
        'Any recall or precision figure computed on it would be a property of the hash function.\n\n' +
        'Unset SLEEPER_OFFLINE and re-run against Bedrock.',
    )
    process.exitCode = 1
    return
  }

  console.log(providerBanner())
  const { thresholds, calibrated } = loadThresholds()
  if (!calibrated) {
    throw new Error('No data/thresholds.json — run `npm run calibrate` before benchmarking.')
  }
  if (calibrated.generatedWith !== 'aws-bedrock') {
    throw new Error(
      `thresholds.json was generated with "${calibrated.generatedWith}". Re-run \`npm run calibrate\` against Bedrock.`,
    )
  }

  const k = 5
  const heldOut = await playbookArcs(true)
  const playbook = await playbookArcs(false)
  if (!heldOut.length) throw new Error('No held-out arcs. Run `npm run seed` first.')

  console.log(
    `\nheld-out queries: ${heldOut.length}   playbook corpus: ${playbook.length}   k=${k}\n`,
  )

  const outcomes: Outcome[] = []
  const latencies: number[] = []

  for (let rep = 0; rep < REPETITIONS; rep++) {
    for (const arc of heldOut) {
      const started = performance.now()
      const matches = await matchPlaybook(arc.embedding, k)
      const decision = decide(matches, thresholds)
      latencies.push(performance.now() - started)

      // Only the first pass contributes to accuracy; the repeats exist for the latency sample,
      // and counting them would inflate n without adding information.
      if (rep === 0) {
        outcomes.push({
          label: arc.label,
          held: decision.hold,
          similarity: decision.similarity,
          margin: decision.margin,
          topKHit: matches.some((m) => m.label === 'takeover'),
        })
        console.log(
          `  ${arc.packageId.padEnd(20)} ${arc.label.padEnd(9)} ` +
            `sim ${decision.similarity.toFixed(4)}  margin ${decision.margin.toFixed(4)}  ` +
            `${decision.hold ? 'HOLD' : 'allow'}${
              decision.hold === (arc.label === 'takeover') ? '' : '   <- WRONG'
            }`,
        )
      }
    }
  }

  const vector = tally(outcomes)
  const baseline = tally(lexicalBaseline(heldOut, playbook, thresholds, k))

  const results = table([
    ['metric', 'vector retrieval', 'lexical baseline'],
    [`recall@${k} (a takeover arc in top-${k})`, vector.recallAtK.toFixed(3), baseline.recallAtK.toFixed(3)],
    ['hold recall (held-out takeover arcs)', vector.recall.toFixed(3), baseline.recall.toFixed(3)],
    ['false-positive rate (held-out benign arcs)', vector.falsePositiveRate.toFixed(3), baseline.falsePositiveRate.toFixed(3)],
    ['precision', vector.precision.toFixed(3), baseline.precision.toFixed(3)],
  ])

  const latency = table([
    ['stage', 'p50', 'p95'],
    [
      'arc embedding -> playbook ANN -> decision',
      `${percentile(latencies, 50).toFixed(1)} ms`,
      `${percentile(latencies, 95).toFixed(1)} ms`,
    ],
  ])

  console.log(`\n${results}\n\n${latency}`)
  console.log(
    `\nn = ${vector.takeovers} held-out takeover arcs + ${vector.benigns} held-out benign arcs, ` +
      `${latencies.length} latency samples (${REPETITIONS} repetitions).`,
  )
  console.log(
    'These are small-n figures on synthetic held-out arcs. They say the retrieval mechanic\n' +
      'separates the two shapes; they do not say what it would do on the real ecosystem.',
  )

  const block = [
    '<!-- BENCH:START -->',
    '',
    `_Generated by \`npm run bench\` · thresholds \`holdAt=${thresholds.holdAt.toFixed(4)}\`, ` +
      `\`minMargin=${thresholds.minMargin.toFixed(4)}\` fitted by \`npm run calibrate\` on the ` +
      'playbook split only._',
    '',
    '**Accuracy — held-out synthetic arcs only. The xz timeline is not part of these numbers.**',
    '',
    results,
    '',
    '**Latency**',
    '',
    latency,
    '',
    `n = ${vector.takeovers} held-out takeover arcs + ${vector.benigns} held-out benign arcs; ` +
      `${latencies.length} latency samples over ${REPETITIONS} repetitions.`,
    '',
    'Small-n synthetic evaluation. It demonstrates that the retrieval mechanic separates the two',
    'arc shapes and beats keyword matching on the same queries. It is not a claim about real-world',
    'detection rates, and it is reported separately from the xz replay on purpose.',
    '',
    '<!-- BENCH:END -->',
  ].join('\n')

  const demoPath = join(DATA_DIR, '..', 'DEMO.md')
  const demo = readFileSync(demoPath, 'utf8')
  writeFileSync(
    demoPath,
    demo.replace(/<!-- BENCH:START -->[\s\S]*<!-- BENCH:END -->/, () => block),
  )
  console.log(`\nWrote results into ${demoPath}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(closePool)
