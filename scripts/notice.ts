/**
 * The notice a distro packager actually receives — visible without an AWS account.
 *
 *   npm run notice
 *   npm run notice -- --clean     # drop the preview lane's rows and exit
 *
 * WHY THIS SCRIPT EXISTS
 *
 * Everything else in this repo shows the *mechanism*: EXPLAIN plans, `prefix spans`, the four-write
 * transaction, p50/p95. The thing the mechanism produces — the hold notice, the distro advisory and
 * the evidence trail behind them — is composed by Bedrock Claude in `src/agent.ts`, and in offline
 * mode the gate correctly never reaches a hold at all. So a reader without AWS credentials could
 * inspect every part of this system except the part it exists to emit.
 *
 * This script closes that hole WITHOUT faking a detection. It runs the real agent loop, prints the
 * gate's real decision (ALLOW, offline, as it should be), and then *deliberately* commits a hold
 * through the real `commitHold` so the output format is inspectable. The transaction, the rows, the
 * ids, the similarity, the matched playbook arc and the evidence trail are all real and produced by
 * the real code path. Only the two prose fields — the rationale and the advisory — are templated,
 * they say so in their own stored text, and they say so again in the banner above them.
 *
 * The banner is mandatory. An unlabelled version of this output would be worse than no output.
 */
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { config } from '../src/config.js'
import { loadThresholds, loadTimeline } from '../src/corpus.js'
import { OFFLINE, providerBanner } from '../src/embeddings.js'
import { extractVersion, runReplay, type Step } from '../src/agent.js'
import type { Decision } from '../src/decide.js'
import {
  auditReader,
  commitHold,
  holdEvidence,
  resetPackage,
  type HoldResult,
} from '../src/memory.js'
import { closePool } from '../src/db.js'
import { MCP_TOOLS, type SqlReader } from '../src/mcp.js'

/**
 * A lane of its own, never `xz-utils`.
 *
 * The cluster this runs against is shared with the hero replay, the benchmark and the integration
 * suite. A deliberately-committed hold sitting on the `xz-utils` package id would flip that
 * package's `trust_state` to 'held' and put a preview row in the middle of the real demo's
 * evidence. The lane is namespaced instead, and the name is visible in every line of the output —
 * a reader can see from the package id alone that this is not the detection lane.
 */
export const NOTICE_PACKAGE = process.env.NOTICE_PACKAGE_ID ?? 'xz-utils-notice-preview'

/** The release the real attack shipped through, and the one the gate assesses in a credentialed run. */
export const NOTICE_VERSION = process.env.NOTICE_RELEASE_VERSION ?? '5.6.0'

/** Stamped on both prose fields, in the database, so the label survives being read back out. */
export const TEMPLATED_MARK = '[TEMPLATED TEXT — NOT MODEL OUTPUT]'

/**
 * Printed first, printed last, and stored in the audit trail.
 *
 * Deliberately not softened. Every sentence here is load-bearing: a reader who takes this output
 * for a detection has been misled by it, and the format being inspectable is not worth that.
 */
export const NOTICE_BANNER = [
  '════════════════════════════════════════════════════════════════════════════════',
  '  OFFLINE NOTICE PREVIEW — READ BEFORE READING ANYTHING BELOW',
  '════════════════════════════════════════════════════════════════════════════════',
  '  The transaction, the rows, the ids, the evidence trail and the format are REAL',
  '  and were produced by the real code path against a real CockroachDB cluster.',
  '',
  '  The rationale and advisory WORDING is TEMPLATED, because Bedrock Claude',
  '  composes those two fields and no AWS credentials are configured here.',
  '',
  '  THIS IS NOT A DETECTION. The gate did not decide to hold. This hold was',
  '  committed DELIBERATELY, by this script, so that the notice a distro packager',
  '  receives is inspectable without an AWS account. No number on this page is a',
  '  measurement, and no line of it is evidence that anything was caught.',
  '════════════════════════════════════════════════════════════════════════════════',
].join('\n')

function rule(title: string): void {
  console.log(`\n${'─'.repeat(78)}\n${title}\n${'─'.repeat(78)}`)
}

/** Everything real that the run produced, and that the templated prose is allowed to quote. */
export type NoticeFacts = {
  packageId: string
  releaseVersion: string
  /** The candidate the agent itself selected and judged the release on — nobody named it. */
  assessedActor: string
  /** Every candidate that had an arc built at this release, in assessment order. */
  assessedActors: string[]
  eventsIngested: number
  assessedAt: string
  prefixScoped: boolean
  decision: Decision
  evidence: string[]
}

/** Column the stored prose wraps at, so an interpolated value cannot produce a ragged paragraph. */
export const WRAP_COLUMN = 92

/**
 * Greedy word wrap. The prose fields are written as whole paragraphs with real values spliced into
 * them, and hand-wrapping such a template guarantees a mid-sentence break the moment a package id
 * or a similarity gets one character longer.
 */
export function wrap(paragraph: string, columns = WRAP_COLUMN): string {
  const lines: string[] = []
  let line = ''
  for (const word of paragraph.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > columns) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(line)
  return lines.join('\n')
}

/**
 * The hold rationale, as a fixed template.
 *
 * In a credentialed run this paragraph is written by Bedrock Claude under `RATIONALE_SYSTEM`
 * (src/agent.ts). Here every *value* is real — the similarity, the margin, the matched arc, the
 * evidence lines all came out of this run — and only the sentences around them are fixed.
 *
 * The provenance paragraph is inside the stored text on purpose. `scripts/explain.ts` reads
 * `release_hold.reason` straight out of the database and prints it with no banner of its own, so a
 * marker that lives only in this script's stdout would be gone the moment anyone audited the row.
 */
export function templatedRationale(f: NoticeFacts): string {
  const d = f.decision
  return [
    wrap(
      `${TEMPLATED_MARK} In a credentialed run Bedrock Claude composes this field (src/agent.ts, ` +
        `RATIONALE_SYSTEM). Bedrock is not configured here, so the sentences are fixed; the ` +
        `numbers, ids and observations inside them are the real ones this run produced.`,
    ),
    '',
    wrap(
      `PROVENANCE — this hold is NOT a detection. It was committed deliberately by ` +
        `\`npm run notice\` (scripts/notice.ts) so the notice format is inspectable without AWS ` +
        `credentials. The gate's own decision on this run was ALLOW: "${d.explanation}"`,
    ),
    '',
    wrap(
      `Release ${f.packageId} ${f.releaseVersion} is paused pending review of the publishing ` +
        `account's behavioural arc.`,
    ),
    '',
    'What the memory layer observed:',
    // Hanging indent, so a wrapped evidence line stays visually under its own bullet.
    ...f.evidence.map((e) => {
      const [first = '', ...rest] = wrap(e, WRAP_COLUMN - 2).split('\n')
      return [`- ${first}`, ...rest.map((l) => `  ${l}`)].join('\n')
    }),
    '',
    wrap(
      `How that arc was retrieved: ${f.eventsIngested} events for this package were read back out ` +
        `of CockroachDB as of ${f.assessedAt}. The account under assessment was not configured — ` +
        `${f.assessedActors.length} candidate(s) (${f.assessedActors.join(', ')}) were ranked out ` +
        `of the package's own memory and assessed independently; this release is judged on ` +
        `"${f.assessedActor}". That account's history was rolled into a ` +
        `${config.arcWindowDays}-day arc, embedded, and searched against this package's own ` +
        `memory with an ANN query bounded by the leading vector-index column (EXPLAIN ` +
        `prefix-scoped: ${f.prefixScoped ? 'YES' : 'NO'}). The same arc vector was then matched, ` +
        `unscoped, against the takeover playbook.`,
    ),
    '',
    wrap(
      `Nearest known takeover shape: ${d.matched?.packageId ?? 'none retrieved'}` +
        (d.matched ? ` at cosine similarity ${d.similarity.toFixed(4)}` : '') +
        `. Nearest ordinary-contributor shape: ${d.nearestBenign?.packageId ?? 'none retrieved'}` +
        (d.nearestBenign ? ` — a separation of ${d.margin.toFixed(4)}` : '') +
        `. Thresholds in force: holdAt ${d.thresholds.holdAt}, minMargin ${d.thresholds.minMargin}.`,
    ),
    '',
    wrap(
      `What to check before clearing: the provenance of the release tarball against the tag it ` +
        `claims to build from; who reviewed the build-system changes in the release branch; ` +
        `whether the accounts that argued for the handover can be tied to any code contribution ` +
        `anywhere.`,
    ),
    '',
    wrap(
      `This is a behavioural hold, not a confirmed vulnerability. Clear it with ` +
        `\`npm run unhold -- --hold <id> --by <who> --note "<why>"\`, which appends the reversal ` +
        `rather than deleting this row.`,
    ),
  ].join('\n')
}

/** The queued distro advisory, same deal: real values, fixed sentences, marked in the stored text. */
export function templatedAdvisory(f: NoticeFacts): string {
  const d = f.decision
  return [
    wrap(
      `${TEMPLATED_MARK} Bedrock Claude composes this field in a credentialed run; the wording ` +
        `below is a fixed template. NOT A DETECTION — committed deliberately by scripts/notice.ts.`,
    ),
    '',
    `ADVISORY — ${f.packageId} ${f.releaseVersion} HELD`,
    '',
    wrap(
      `Downstream packagers (Debian, Fedora, Arch): do not promote ${f.packageId} ` +
        `${f.releaseVersion} into a distribution channel while this hold stands.`,
    ),
    '',
    wrap(
      `Reason: the publishing account's multi-year behavioural arc matches a known ` +
        `maintainer-takeover shape (${d.matched?.packageId ?? 'n/a'}, cosine similarity ` +
        `${d.similarity.toFixed(4)}, separation from the nearest ordinary-contributor arc ` +
        `${d.margin.toFixed(4)}).`,
    ),
    '',
    wrap(
      `Recommended action: keep the previous release in place, rebuild from the tagged source ` +
        `rather than the published tarball if you need the version, and ask the project to name a ` +
        `second reviewer for the release artifact.`,
    ),
    '',
    wrap(
      `This hold is BEHAVIOURAL, not a confirmed vulnerability. No exploit has been demonstrated ` +
        `and no CVE is claimed. It may be withdrawn; a retraction advisory is queued to this same ` +
        `outbox if it is.`,
    ),
  ].join('\n')
}

/** What lands in `audit_log.detail` — same disclaimer, same real decision line, same evidence. */
export function templatedAuditDetail(f: NoticeFacts): string {
  return [
    'PREVIEW HOLD — committed deliberately by scripts/notice.ts, NOT decided by the gate',
    `gate decision on this run: ALLOW — ${f.decision.explanation}`,
    'rationale and advisory wording: TEMPLATED (Bedrock unavailable); all values real',
    `assessed candidates: ${f.assessedActors.join(', ')} — judged on ${f.assessedActor}`,
    `EXPLAIN prefix-scoped: ${f.prefixScoped}`,
    ...f.evidence,
  ].join(' | ')
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

/** The offline arc summary is a 4k-character blob; the row keeps all of it, the terminal does not. */
function clip(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}… [clipped for display at ${max} chars — the full text is in the row]`
}

type Capture = {
  actorId: string
  arcSummary: string
  evidence: string[]
  prefixScoped: boolean
  decision: Decision
  assessedActors: string[]
}

/**
 * Renders the replay, in full for the assessment at `NOTICE_VERSION` and in one line for the
 * others. The gate assesses every release event, and printing three full arc/EXPLAIN/match blocks
 * would bury the one this preview is about.
 */
function makeRenderer(onCapture: (c: Capture) => void): (step: Step) => void {
  let currentVersion: string | null = null
  let onTarget = false
  let assessed: string[] = []
  let pending: Partial<Capture> = {}

  return (step: Step): void => {
    switch (step.type) {
      case 'log':
        console.log(step.message)
        break

      case 'candidates':
        assessed = step.assessed
        if (!onTarget) break
        rule(`CANDIDATE SELECTION — nobody named the account under assessment`)
        console.log(`  ${step.considered} actors have events in this package's memory.`)
        console.log(`  ${step.reason}`)
        for (const c of step.ranked) {
          console.log(
            `    ${step.assessed.includes(c.actorId) ? '→' : ' '} ${c.actorId.padEnd(14)} ` +
              `score ${c.score.toFixed(4)}`,
          )
        }
        break

      case 'event': {
        const date = step.event.occurredAt.slice(0, 10)
        if (step.event.kind === 'release') {
          currentVersion = extractVersion(step.event.content, date)
          onTarget = currentVersion === NOTICE_VERSION
          pending = {}
        }
        console.log(
          `  + [${String(step.index + 1).padStart(2)}/${step.total}] ${date} ` +
            `${step.event.kind.padEnd(17)} ${step.event.actorId.padEnd(14)} ` +
            `${step.event.content.slice(0, 52)}…  (${step.latencyMs}ms)`,
        )
        break
      }

      case 'arc':
        pending.actorId = step.actorId
        pending.arcSummary = step.summary
        pending.evidence = step.evidence
        if (!onTarget) break
        rule(`ACTOR ARC — ${step.actorId}  (assessment at release ${currentVersion})`)
        console.log(
          `  window ${step.windowStart.slice(0, 10)} → ${step.windowEnd.slice(0, 10)}  ` +
            `(${step.windowEventCount} events in window, ${step.cumulativeEvents} cumulative)`,
        )
        console.log(`\n  ${clip(step.summary, 480).replace(/\n/g, '\n  ')}\n`)
        console.log('  Structural evidence held in memory:')
        for (const line of step.evidence) console.log(`    - ${line}`)
        break

      case 'explain':
        pending.prefixScoped = step.explain.prefixScoped
        if (!onTarget) break
        rule('PREFIX-SCOPED VECTOR SEARCH — EXPLAIN (the memory layer at work)')
        console.log(step.explain.plan.replace(/^/gm, '  '))
        console.log(
          `\n  vector index used: ${step.explain.usedVectorIndex ? 'YES' : 'NO'}   ` +
            `prefix-scoped to this package: ${step.explain.prefixScoped ? 'YES' : 'NO'}`,
        )
        console.log("\n  Nearest events in this package's own memory:")
        for (const n of step.neighbours) {
          console.log(
            `    ${n.similarity.toFixed(4)}  ${n.occurredAt.toISOString().slice(0, 10)} ` +
              `[${n.kind}] ${n.content.slice(0, 50)}…`,
          )
        }
        break

      case 'match':
        if (!onTarget) break
        rule('UNSCOPED PLAYBOOK MATCH')
        for (const [i, m] of step.matches.entries()) {
          console.log(
            `  ${i + 1}. ${m.packageId.padEnd(20)} ${m.label.padEnd(9)} ` +
              `similarity ${m.similarity.toFixed(4)}`,
          )
        }
        break

      case 'decision':
        if (!onTarget) {
          console.log(
            `    ↳ release ${step.releaseVersion} assessed → ` +
              `${step.decision.hold ? 'HOLD' : 'ALLOW'} ` +
              `(similarity ${step.decision.similarity.toFixed(4)}, ` +
              `margin ${step.decision.margin.toFixed(4)})`,
          )
          break
        }
        rule(`THE GATE'S OWN DECISION — release ${step.releaseVersion}`)
        console.log(`  ${step.decision.hold ? 'HOLD' : 'ALLOW'}  (${step.latencyMs}ms from ingest)`)
        console.log(`  ${step.decision.explanation}`)
        console.log(
          `  thresholds: holdAt ${step.decision.thresholds.holdAt} / ` +
            `minMargin ${step.decision.thresholds.minMargin}`,
        )
        if (
          pending.actorId !== undefined &&
          pending.arcSummary !== undefined &&
          pending.evidence !== undefined &&
          pending.prefixScoped !== undefined
        ) {
          onCapture({
            actorId: pending.actorId,
            arcSummary: pending.arcSummary,
            evidence: pending.evidence,
            prefixScoped: pending.prefixScoped,
            decision: step.decision,
            assessedActors: assessed,
          })
        }
        break

      // A hold emitted by the gate itself would mean this script is running with credentials and
      // the preview is unnecessary. Printed rather than swallowed, because that is worth knowing.
      case 'hold':
        rule(`THE GATE HELD ON ITS OWN — release ${step.releaseVersion}`)
        console.log(`  release_hold id: ${step.holdId}`)
        console.log(`  This is a real detection. Nothing below it is needed; inspect that hold with`)
        console.log(`    npm run explain -- --hold ${step.holdId}`)
        break
    }
  }
}

/** Same announcement `scripts/explain.ts` makes: which audit path ran is a fact of the output. */
function announce(reader: SqlReader): void {
  if (reader.via === 'mcp') {
    console.log(`AUDIT PATH: CockroachDB Cloud Managed MCP Server (${config.mcp.endpoint()})`)
    console.log(`            ${reader.reason}`)
    console.log(
      `            tools: ${MCP_TOOLS.tableSchema}, ${MCP_TOOLS.explain}, ${MCP_TOOLS.select}`,
    )
  } else {
    console.log('AUDIT PATH: direct SQL over the pg pool — NOT the Managed MCP Server')
    console.log(`            reason: ${reader.reason}`)
  }
}

/**
 * The evidence trail, rendered exactly as `scripts/explain.ts --hold <uuid>` renders it.
 *
 * Duplicated rather than imported: `explainHold` is a module-private function in a script that
 * calls `main()` at import time, so there is nothing to import without editing that file. See the
 * note at the end of this file.
 */
async function renderEvidence(reader: SqlReader, holdId: string): Promise<void> {
  const evidence = await holdEvidence(holdId, reader)
  if (!evidence) throw new Error(`No release_hold with id ${holdId} — the commit did not land.`)

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
    console.log(`\n  ${clip(evidence.matchedArc.arcSummary, 480).replace(/\n/g, '\n  ')}`)
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
}

// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (process.argv.includes('--clean')) {
    await resetPackage(NOTICE_PACKAGE)
    console.log(`Preview lane ${NOTICE_PACKAGE} reset: events, arcs, holds, advisories and audit`)
    console.log(`rows deleted; trust_state back to 'trusted'. Nothing else on the cluster touched.`)
    return
  }

  console.log(NOTICE_BANNER)

  const timeline = loadTimeline(NOTICE_PACKAGE)
  const { thresholds, calibrated } = loadThresholds()

  console.log(`\npreview lane:  ${NOTICE_PACKAGE}  (never ${config.packageId} — see scripts/notice.ts)`)
  console.log(`timeline:      the public CVE-2024-3094 xz-utils reconstruction, ${timeline.events.length} events`)
  console.log(providerBanner())
  console.log(
    calibrated
      ? `thresholds:    calibrated (${calibrated.fittedOn}) holdAt=${thresholds.holdAt.toFixed(4)} minMargin=${thresholds.minMargin.toFixed(4)}`
      : `thresholds:    UNCALIBRATED fallback holdAt=${thresholds.holdAt} minMargin=${thresholds.minMargin}`,
  )

  rule(`STEP 1 — THE REAL AGENT LOOP, INGESTING THE xz TIMELINE INTO COCKROACHDB`)
  let captured: Capture | null = null
  const summary = await runReplay(
    {
      packageId: NOTICE_PACKAGE,
      // Deliberately NOT pinned. `suspectActor` is an optional override; leaving it out is what
      // makes the agent enumerate and rank candidates out of the package's own memory, which is
      // the behaviour a packager's notice should be able to show.
      windowDays: config.arcWindowDays,
      thresholds,
      events: timeline.events,
    },
    makeRenderer((c) => {
      captured = c
    }),
  )

  // Checked BEFORE the capture, not after: a gate that holds at an earlier release stops assessing
  // later ones, so there would legitimately be no 5.6.0 assessment to capture. That is the good
  // outcome, and it must not surface as "nothing was committed".
  if (summary.holdId) {
    console.log(
      `\nThe gate held on its own — this preview is unnecessary, and nothing was committed by it.` +
        `\nInspect the real hold instead:` +
        `\n  npm run explain -- --hold ${summary.holdId}`,
    )
    return
  }

  const facts = captured as Capture | null
  if (!facts) {
    throw new Error(
      `The replay never reached an assessment at release ${NOTICE_VERSION}. Nothing was committed. ` +
        `Set NOTICE_RELEASE_VERSION to a release version present in data/xz-timeline.json.`,
    )
  }

  rule('STEP 2 — WHAT JUST HAPPENED, STATED PLAINLY')
  console.log(
    `  The gate assessed release ${NOTICE_VERSION} — judging it on "${facts.actorId}", a candidate` +
      `\n  it selected itself out of ${facts.assessedActors.length} it ranked — and ALLOWED it.`,
  )
  console.log(`  ${facts.decision.explanation}`)
  console.log(
    OFFLINE
      ? '\n  That is the correct offline outcome. The offline embedder is a hashed bag-of-words: it\n' +
          '  carries no sense of what a takeover arc means, so it cannot separate one from an\n' +
          '  ordinary contributor. No detection has occurred and none is claimed.'
      : '\n  Bedrock is configured, and the gate still allowed this release. That is a real ALLOW.',
  )
  console.log(
    '\n  What follows is therefore a DELIBERATE hold, committed by this script, for one reason\n' +
      '  only: so the notice a distro packager receives can be read without AWS credentials.',
  )

  rule('STEP 3 — COMMITTING THE PREVIEW HOLD (the real `commitHold`, one transaction)')
  // The assessment date is the release event's own date, not "now" — the arc was built as of the
  // moment the tarball shipped, and saying "now" would misdate the evidence.
  const releaseEvent = timeline.events.find(
    (e) => e.kind === 'release' && extractVersion(e.content, '') === NOTICE_VERSION,
  )
  const noticeFacts: NoticeFacts = {
    packageId: NOTICE_PACKAGE,
    releaseVersion: NOTICE_VERSION,
    assessedActor: facts.actorId,
    assessedActors: facts.assessedActors,
    eventsIngested: summary.ingested,
    assessedAt: releaseEvent?.occurredAt.slice(0, 10) ?? 'the release event',
    prefixScoped: facts.prefixScoped,
    decision: facts.decision,
    evidence: facts.evidence,
  }

  const result: HoldResult = await commitHold({
    packageId: NOTICE_PACKAGE,
    releaseVersion: NOTICE_VERSION,
    reason: templatedRationale(noticeFacts),
    matchedPlaybookId: facts.decision.matched?.id ?? null,
    similarity: facts.decision.similarity,
    advisoryText: templatedAdvisory(noticeFacts),
    auditDetail: templatedAuditDetail(noticeFacts),
  })

  console.log(`  release_hold id: ${result.holdId}`)
  console.log(`  advisory id:     ${result.advisoryId}`)
  console.log(`  audit id:        ${result.auditId}`)
  console.log(`  committed at:    ${result.committedAt.toISOString()}`)
  console.log(`  ONE transaction, ${result.writes.length} writes, all-or-nothing:`)
  for (const w of result.writes) console.log(`    - ${w}`)
  console.log(
    `\n  Real: the transaction, the four rows, the ids above, the similarity ` +
      `${facts.decision.similarity.toFixed(4)} and the`,
  )
  console.log(`  matched playbook arc — every one of them produced by the real code path.`)
  console.log(`  Templated: the two prose fields, and they say so in their own stored text.`)

  rule('STEP 4 — THE EVIDENCE TRAIL, AS `npm run explain -- --hold <uuid>` RENDERS IT')
  const reader = await auditReader()
  announce(reader)
  try {
    await renderEvidence(reader, result.holdId)
  } finally {
    rule('AUDIT PATH REPORT')
    console.log(`  via:   ${reader.via}`)
    console.log(`  calls: ${reader.calls.join(', ') || '(none)'}`)
    await reader.close()
  }

  console.log(`\n${NOTICE_BANNER}`)
  console.log(`\nRe-read this trail at any time:`)
  console.log(`  npm run explain -- --hold ${result.holdId}`)
  console.log(`\nRemove the preview lane from the cluster:`)
  console.log(`  npm run notice -- --clean`)
}

const isMain =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))

if (isMain) {
  main()
    .catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
    .finally(closePool)
}

/*
 * WHAT WOULD MAKE THIS CLEANER, IF `src/**` AND `scripts/explain.ts` COULD CHANGE
 *
 * 1. `scripts/explain.ts` keeps `explainHold`, `announce`, `report` and `rule` module-private and
 *    calls `main()` at import time. The evidence renderer above is a copy of `explainHold` as a
 *    result, and two renderers can drift. Extracting them into `src/render.ts` would leave exactly
 *    one implementation of "explain your hold".
 *
 * 2. `commitHold` hardcodes `actor` to 'agent' in the `audit_log` INSERT. This hold was not
 *    committed by the agent, and the audit row says it was. The disclaimer is carried in
 *    `detail` instead, which works but is the wrong column for it. A `HoldInput.actor` (default
 *    'agent') would let a deliberately-committed row identify itself in the field an auditor reads
 *    first.
 *
 * 3. `runReplay` has no way to stop after a given event, so the replay runs on past 5.6.0 and
 *    assesses 5.6.1 as well. Harmless — the 5.6.0 arc is built `asOf` the 5.6.0 event and later
 *    ingests cannot reach back into it — but a `stopAfter` option would keep the transcript to the
 *    one assessment it is about.
 */
