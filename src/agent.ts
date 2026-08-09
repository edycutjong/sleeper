/**
 * The agent loop.
 *
 * ingest event -> embed -> roll up the actor arc -> prefix-scoped retrieval over this package's
 * own memory -> unscoped retrieval against the takeover playbook -> threshold decision -> if it
 * trips, one atomic HOLD transaction.
 *
 * Every step is emitted so the same function drives the terminal replay, the HTTP demo and the
 * Lambda handler. There is exactly one implementation of the decision path in this repo.
 */
import { converse, embed } from './embeddings.js'
import {
  actorHistory,
  arcWindow,
  commitHold,
  explainScoped,
  ingestEvent,
  matchPlaybook,
  packageHistory,
  resetPackage,
  scopedNeighbours,
  upsertActorArc,
  type ExplainResult,
  type IngestInput,
  type ScopedNeighbour,
} from './memory.js'
import { decide, type Decision, type PlaybookMatch, type Thresholds } from './decide.js'
import { actorSignals, evidenceLines, pressureAccounts, type ActorSignals } from './signals.js'

export type TimelineEvent = IngestInput & { approximate?: boolean }

export type Step =
  | {
      type: 'event'
      index: number
      total: number
      eventId: string
      event: TimelineEvent
      afterHold: boolean
      latencyMs: number
    }
  | {
      type: 'arc'
      actorId: string
      summary: string
      windowStart: string
      windowEnd: string
      windowEventCount: number
      cumulativeEvents: number
      signals: ActorSignals
      evidence: string[]
    }
  | { type: 'explain'; explain: ExplainResult; neighbours: ScopedNeighbour[] }
  | { type: 'match'; matches: PlaybookMatch[] }
  | { type: 'decision'; decision: Decision; releaseVersion: string; latencyMs: number }
  | {
      type: 'hold'
      holdId: string
      releaseVersion: string
      reason: string
      advisory: string
      writes: string[]
      committedAt: string
      latencyMs: number
    }
  | { type: 'log'; message: string }

export type ReplayOptions = {
  packageId: string
  suspectActor: string
  windowDays: number
  thresholds: Thresholds
  events: TimelineEvent[]
  /** Skip the destructive reset when replaying into a cluster that already holds the corpus. */
  reset?: boolean
}

export type ReplaySummary = {
  ingested: number
  holdId: string | null
  heldAt: string | null
  releaseVersion: string | null
  decision: Decision | null
  prefixScoped: boolean
  /** Wall-clock from the triggering release event landing to the HOLD transaction committing. */
  decisionLatencyMs: number | null
}

type Emit = (step: Step) => void | Promise<void>

/** Release version out of the event text, e.g. "publishes the xz-utils 5.6.0 release tarball". */
export function extractVersion(content: string, fallback: string): string {
  return content.match(/\b(\d+\.\d+(?:\.\d+)?)\b/)?.[1] ?? fallback
}

const ARC_SYSTEM =
  "You summarise an open-source contributor's behavioural arc for a supply-chain risk system. " +
  'Write one dense paragraph describing the SHAPE of the trajectory: how the actor entered the ' +
  'project, how trust escalated and how fast, what kinds of change they concentrated on, and ' +
  'what other accounts did around them. Describe behaviour, not verdicts — do not say whether ' +
  'this is an attack, and do not name the package or any real person.'

const RATIONALE_SYSTEM =
  'You write release-gate hold notices for downstream distribution maintainers. Be precise, ' +
  'factual and calm. State what the memory layer observed, why the pattern justifies pausing a ' +
  'release, and what the maintainer should check to clear or confirm it. Never assert intent or ' +
  'accuse a named person — describe the behavioural pattern and the evidence. Under 180 words.'

/**
 * Builds the arc the decision is made on, reading the actor's history back out of CockroachDB.
 *
 * The 90-day window bounds the recent detail, but the summary also carries cumulative trajectory
 * (tenure, privilege escalation, what the actor concentrates on), because a 90-day slice of this
 * attack is three innocuous commits. The premise of the project is that the signal only exists in
 * the multi-year arc, so the arc is what gets embedded.
 */
async function buildArc(
  opts: ReplayOptions,
  asOf: Date,
  emit: Emit,
): Promise<{ embedding: number[]; summary: string; evidence: string[]; signals: ActorSignals }> {
  const history = await actorHistory(opts.packageId, opts.suspectActor, asOf)
  const wholePackage = await packageHistory(opts.packageId, asOf)
  const window = arcWindow(asOf, opts.windowDays, 0)
  const recent = history.filter((e) => e.occurredAt >= window.windowStart)
  window.eventCount = recent.length

  const signals = actorSignals(history, opts.suspectActor, asOf)
  const pressure = pressureAccounts(wholePackage, asOf).filter(
    (p) => p.actorId !== opts.suspectActor,
  )
  const evidence = evidenceLines(signals, pressure)

  const prompt = [
    `Actor first public activity: ${
      signals.firstSeen ? signals.firstSeen.toISOString().slice(0, 10) : 'unknown'
    } (${signals.tenureDays} days before this assessment)`,
    `Privilege changes on record: ${signals.privilegeChanges}`,
    `Releases produced by this actor: ${signals.releases}`,
    `Share of commits touching build/CI machinery: ${Math.round(signals.buildSystemShare * 100)}%`,
    `Other accounts arguing for the handover without contributing code: ${
      pressure.map((p) => p.actorId).join(', ') || 'none'
    }`,
    '',
    `Recent activity (last ${opts.windowDays} days):`,
    ...recent.map((e) => `- ${e.occurredAt.toISOString().slice(0, 10)} [${e.kind}] ${e.content}`),
    '',
    'Full trajectory:',
    ...history.map((e) => `- ${e.occurredAt.toISOString().slice(0, 10)} [${e.kind}] ${e.content}`),
  ].join('\n')

  const summary = await converse(ARC_SYSTEM, prompt)
  const embedding = await embed(summary)
  await upsertActorArc(opts.packageId, opts.suspectActor, window, summary, embedding)

  await emit({
    type: 'arc',
    actorId: opts.suspectActor,
    summary,
    windowStart: window.windowStart.toISOString(),
    windowEnd: window.windowEnd.toISOString(),
    windowEventCount: window.eventCount,
    cumulativeEvents: history.length,
    signals,
    evidence,
  })

  return { embedding, summary, evidence, signals }
}

async function composeHoldText(
  opts: ReplayOptions,
  version: string,
  decision: Decision,
  arcSummary: string,
  evidence: string[],
): Promise<{ reason: string; advisory: string }> {
  const prompt = [
    `Package: ${opts.packageId}`,
    `Release held: ${version}`,
    `Nearest known takeover shape: ${decision.matched?.packageId ?? 'n/a'} at cosine similarity ` +
      `${decision.similarity.toFixed(4)}`,
    `Separation from the nearest ordinary-contributor shape: ${decision.margin.toFixed(4)}`,
    '',
    'Observed behavioural arc:',
    arcSummary,
    '',
    'Structural evidence from the memory layer:',
    ...evidence.map((e) => `- ${e}`),
  ].join('\n')

  const reason = await converse(RATIONALE_SYSTEM, prompt, 600)
  const advisory = await converse(
    'You write short advisories to downstream distribution packagers (Debian, Fedora, Arch). ' +
      'State the package, the held version, the recommended action, and that the hold is ' +
      'behavioural rather than a confirmed vulnerability. Under 100 words.',
    `${prompt}\n\nHold rationale:\n${reason}`,
    400,
  )
  return { reason, advisory }
}

/**
 * Assessment fires on a release event: that is the moment a decision is actionable, and the
 * moment the real attack succeeded.
 */
async function assess(
  opts: ReplayOptions,
  event: TimelineEvent,
  eventLandedAt: number,
  emit: Emit,
): Promise<{ decision: Decision; holdId: string | null; prefixScoped: boolean; version: string; latencyMs: number }> {
  const asOf = new Date(event.occurredAt)
  const version = extractVersion(event.content, asOf.toISOString().slice(0, 10))

  const arc = await buildArc(opts, asOf, emit)

  const [explain, neighbours] = await Promise.all([
    explainScoped(opts.packageId, arc.embedding),
    scopedNeighbours(opts.packageId, arc.embedding, 5),
  ])
  await emit({ type: 'explain', explain, neighbours })

  const matches = await matchPlaybook(arc.embedding, 5)
  await emit({ type: 'match', matches })

  const decision = decide(matches, opts.thresholds)
  await emit({
    type: 'decision',
    decision,
    releaseVersion: version,
    latencyMs: Date.now() - eventLandedAt,
  })

  if (!decision.hold) {
    return { decision, holdId: null, prefixScoped: explain.prefixScoped, version, latencyMs: Date.now() - eventLandedAt }
  }

  const { reason, advisory } = await composeHoldText(
    opts,
    version,
    decision,
    arc.summary,
    arc.evidence,
  )

  const result = await commitHold({
    packageId: opts.packageId,
    releaseVersion: version,
    reason,
    matchedPlaybookId: decision.matched?.id ?? null,
    similarity: decision.similarity,
    advisoryText: advisory,
    auditDetail: [
      decision.explanation,
      `EXPLAIN prefix-scoped: ${explain.prefixScoped}`,
      ...arc.evidence,
    ].join(' | '),
  })

  const latencyMs = Date.now() - eventLandedAt
  await emit({
    type: 'hold',
    holdId: result.holdId,
    releaseVersion: version,
    reason,
    advisory,
    writes: result.writes,
    committedAt: result.committedAt.toISOString(),
    latencyMs,
  })

  return { decision, holdId: result.holdId, prefixScoped: explain.prefixScoped, version, latencyMs }
}

export async function runReplay(opts: ReplayOptions, emit: Emit): Promise<ReplaySummary> {
  if (opts.reset !== false) {
    await resetPackage(opts.packageId)
    await emit({ type: 'log', message: `Memory reset for ${opts.packageId}.` })
  }

  const ordered = [...opts.events].sort(
    (a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime(),
  )

  const summary: ReplaySummary = {
    ingested: 0,
    holdId: null,
    heldAt: null,
    releaseVersion: null,
    decision: null,
    prefixScoped: false,
    decisionLatencyMs: null,
  }

  for (const [index, event] of ordered.entries()) {
    const started = Date.now()
    const embedding = await embed(event.content)
    const eventId = await ingestEvent(event, embedding)
    summary.ingested++

    await emit({
      type: 'event',
      index,
      total: ordered.length,
      eventId,
      event,
      // Events after the hold are still ingested and shown: they are what actually happened in
      // the real world while the backdoored tarball was live, which is the point of the demo.
      afterHold: summary.holdId !== null,
      latencyMs: Date.now() - started,
    })

    // Only assess on releases, and only before a hold — once a package is held, further releases
    // are already blocked and re-deciding would just be noise.
    if (event.kind !== 'release' || summary.holdId) continue

    const outcome = await assess(opts, event, started, emit)
    summary.decision = outcome.decision
    summary.prefixScoped = summary.prefixScoped || outcome.prefixScoped
    if (outcome.holdId) {
      summary.holdId = outcome.holdId
      summary.heldAt = event.occurredAt
      summary.releaseVersion = outcome.version
      summary.decisionLatencyMs = outcome.latencyMs
    }
  }

  return summary
}
