/**
 * Fits the hold thresholds — on the PLAYBOOK half only, by leave-one-out.
 *
 *   npm run calibrate
 *
 * Each playbook arc is scored against every other playbook arc (never against itself), giving a
 * nearest-takeover similarity and a takeover-vs-benign margin per arc. `fitThresholds` picks the
 * cut points maximising balanced accuracy over those scores.
 *
 * The held-out arcs are not read here. That is the whole discipline: if the thresholds had seen
 * the evaluation set, `npm run bench` would be measuring how well the thresholds were fitted to
 * the answer sheet rather than whether the mechanic generalises.
 */
import { writeFileSync } from 'node:fs'
import { THRESHOLDS_PATH } from '../src/corpus.js'
import { decide, fitThresholds } from '../src/decide.js'
import { OFFLINE, providerBanner } from '../src/embeddings.js'
import { matchPlaybook, playbookArcs } from '../src/memory.js'
import { closePool } from '../src/db.js'

async function main(): Promise<void> {
  console.log(providerBanner())

  const arcs = await playbookArcs(false)
  if (arcs.length < 4) {
    throw new Error(`Only ${arcs.length} playbook arcs found. Run \`npm run seed\` first.`)
  }

  const scored: { id: string; label: 'takeover' | 'benign'; similarity: number; margin: number }[] =
    []

  for (const arc of arcs) {
    const matches = await matchPlaybook(arc.embedding, 5, arc.id)
    // Reuse the real decision function's own notion of similarity/margin so calibration can
    // never drift from what the agent actually computes at runtime.
    const probe = decide(matches, { holdAt: 0, minMargin: -1 })
    scored.push({
      id: arc.packageId,
      label: arc.label,
      similarity: probe.similarity,
      margin: probe.margin,
    })
    console.log(
      `  ${arc.packageId.padEnd(20)} ${arc.label.padEnd(9)} ` +
        `nearest-takeover ${probe.similarity.toFixed(4)}  margin ${probe.margin.toFixed(4)}`,
    )
  }

  const thresholds = fitThresholds(scored)

  const correct = scored.filter((s) => {
    const wouldHold = s.similarity >= thresholds.holdAt && s.margin >= thresholds.minMargin
    return wouldHold === (s.label === 'takeover')
  }).length

  console.log(`\nFitted thresholds (leave-one-out over ${arcs.length} playbook arcs):`)
  console.log(`  holdAt    ${thresholds.holdAt.toFixed(4)}`)
  console.log(`  minMargin ${thresholds.minMargin.toFixed(4)}`)
  console.log(`  in-sample accuracy ${correct}/${scored.length} (NOT a reported metric)`)

  const payload = {
    ...thresholds,
    fittedOn: 'playbook split only, leave-one-out',
    method: 'maximise balanced accuracy over candidate cut points; ties break toward higher holdAt',
    generatedWith: OFFLINE ? 'OFFLINE-STAND-IN (not valid for reported numbers)' : 'aws-bedrock',
  }
  writeFileSync(THRESHOLDS_PATH, `${JSON.stringify(payload, null, 2)}\n`)
  console.log(`\nWrote ${THRESHOLDS_PATH}`)
  if (OFFLINE) {
    console.log(
      'WARNING: fitted in offline mode. Re-run against Bedrock before quoting any number.',
    )
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(closePool)
