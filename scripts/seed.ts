/**
 * Seeds the retrieval corpus.
 *
 *   npm run seed
 *
 * Both splits land in `takeover_playbook`, distinguished by the `held_out` flag: the playbook
 * half is what an incoming arc is matched against, the held-out half is excluded from every
 * retrieval query the agent runs and exists only so `npm run bench` has data the system has
 * never seen. Keeping both in one table means the exclusion is visible in the SQL rather than
 * being a promise made in a README.
 */
import { loadSynthetic } from '../src/corpus.js'
import { embed, providerBanner } from '../src/embeddings.js'
import { clearPlaybook, insertPlaybookArc } from '../src/memory.js'
import { closePool } from '../src/db.js'

async function main(): Promise<void> {
  console.log(providerBanner())
  const synthetic = loadSynthetic()

  await clearPlaybook()
  console.log('Cleared takeover_playbook (and any holds referencing it).')

  for (const arc of synthetic.playbook) {
    const embedding = await embed(arc.arc_summary)
    await insertPlaybookArc(
      {
        packageId: arc.id,
        label: arc.label,
        source: 'synthetic',
        heldOut: false,
        arcSummary: arc.arc_summary,
      },
      embedding,
    )
    console.log(`  playbook  ${arc.id.padEnd(20)} ${arc.label}`)
  }

  for (const arc of synthetic.heldout) {
    const embedding = await embed(arc.arc_summary)
    await insertPlaybookArc(
      {
        packageId: arc.id,
        label: arc.label,
        source: 'synthetic',
        heldOut: true,
        arcSummary: arc.arc_summary,
      },
      embedding,
    )
    console.log(`  held out  ${arc.id.padEnd(20)} ${arc.label}   (never retrieved by the agent)`)
  }

  console.log(
    `\nSeeded ${synthetic.playbook.length} playbook arcs and ${synthetic.heldout.length} held-out arcs.`,
  )
  console.log('Next: npm run calibrate   (fits thresholds on the playbook half only)')
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(closePool)
