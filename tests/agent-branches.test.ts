/**
 * Coverage for src/agent.ts paths that tests/agent.test.ts does not reach.
 *
 * tests/agent.test.ts already owns: candidate ranking against the real xz corpus, prompt-injection
 * fencing, trajectory bounding at 10k events, and the Bedrock retry policy. None of that is repeated
 * here.
 *
 * What is genuinely untested before this file: `selectCandidates`'s own edge cases (independent of
 * whether the ranking under it is realistic), the exact wording of the "recent" section's own
 * omission notice (only the "full trajectory" section's notice was ever asserted), and — the big
 * one — `assess`/`runReplay` themselves. Nothing in the existing suite ever calls `runReplay`
 * in-process without a live cluster, so the hold/allow plumbing, the "stop re-deciding after a
 * hold" rule, the reset flag and the evidence-is-not-a-vote claim were all exercised only by
 * `tests/integration.test.ts`, which is skipped on a clean checkout with no DATABASE_URL.
 *
 * `../src/memory.js` is fully mocked so this runs with no cluster, and `../src/bedrock.js` is
 * mocked so it runs with no AWS credentials regardless of SLEEPER_OFFLINE. `../src/decide.js` is
 * deliberately left real: it is the pure function under scrutiny in the evidence-is-not-a-vote
 * test, and mocking it would defeat the point.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_CANDIDATES,
  MAX_PROMPT_EVENTS,
  composeArcPrompt,
  rankCandidates,
  runReplay,
  selectCandidates,
  type Step,
  type TimelineEvent,
} from '../src/agent.js'
import type { Thresholds } from '../src/decide.js'
import type { ActorSignals } from '../src/signals.js'
import type { StoredEvent } from '../src/memory.js'

vi.mock('../src/memory.js', () => ({
  actorHistory: vi.fn(),
  arcWindow: vi.fn(),
  commitHold: vi.fn(),
  explainScoped: vi.fn(),
  ingestEvent: vi.fn(),
  matchPlaybook: vi.fn(),
  packageHistory: vi.fn(),
  resetPackage: vi.fn(),
  scopedNeighbours: vi.fn(),
  upsertActorArc: vi.fn(),
}))

// Not exercised while SLEEPER_OFFLINE=1 (embed/converse never reach it then), but mocked anyway so
// this file cannot make a real network call regardless of how the env var is set when it runs.
vi.mock('../src/bedrock.js', () => ({
  embed: vi.fn(async () => new Array(1024).fill(0.001)),
  converse: vi.fn(async (_system: string, prompt: string) => `stub-converse:${prompt.length}`),
  isRetryable: () => false,
  withRetry: async (fn: () => Promise<unknown>) => fn(),
}))

import * as memory from '../src/memory.js'

const day = (y: number, m: number, d: number): Date => new Date(Date.UTC(y, m - 1, d))

function storedEvent(
  actorId: string,
  kind: string,
  content: string,
  occurredAt: Date,
  packageId = 'pkg',
): StoredEvent {
  return {
    id: `${actorId}-${kind}-${occurredAt.toISOString()}`,
    packageId,
    actorId,
    kind,
    content,
    occurredAt,
    sourceUrl: null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Part A — pure functions: selectCandidates edge cases + composeArcPrompt wording
// that the existing fencing/bounding tests never construct.
// ─────────────────────────────────────────────────────────────────────────────

describe('selectCandidates edge cases', () => {
  it('handles a package with no memory at all, still surfacing the event actor', () => {
    // No candidates were ranked — there IS no history — but the event's own actor must still be
    // assessed. If this regressed to `[]`, `assess` would throw ("no candidate was assessed").
    const { actorIds, reason } = selectCandidates([], { mustInclude: 'lonely-actor', max: 3 })
    expect(actorIds).toEqual(['lonely-actor'])
    expect(reason).toContain('0 actor(s)')
  })

  it('does not pad a single-actor package up to `max`', () => {
    const asOf = day(2024, 6, 1)
    const corpus = [storedEvent('sole-actor', 'commit', 'a small fix', day(2024, 1, 1))]
    const ranked = rankCandidates(corpus, asOf)
    expect(ranked).toHaveLength(1)

    const { actorIds } = selectCandidates(ranked, { max: 5 })
    // There is only one actor in memory; asking for 5 must not invent four more.
    expect(actorIds).toEqual(['sole-actor'])
  })

  it('does not duplicate mustInclude when the ranking already put it first', () => {
    const asOf = day(2024, 6, 1)
    const corpus = ['alpha', 'bravo', 'charlie', 'delta', 'echo'].flatMap((actorId, i) => [
      storedEvent(actorId, 'commit', `commit ${i} touching the parser`, day(2024, 1, 1 + i * 10)),
      storedEvent(actorId, 'release', `publishes release ${i}.0.0`, asOf),
    ])
    const ranked = rankCandidates(corpus, asOf)
    expect(ranked.length).toBe(5)

    const top = ranked[0]!.actorId
    const { actorIds } = selectCandidates(ranked, { mustInclude: top, max: 3 })
    // The dedupe branch (`!picked.includes(c.actorId)`) is what is under test: without it, the top
    // actor would appear twice and a real candidate would be silently dropped from the assessed set.
    expect(actorIds[0]).toBe(top)
    expect(actorIds).toHaveLength(3)
    expect(new Set(actorIds).size).toBe(3)
  })

  it('falls back to MAX_CANDIDATES when the caller does not pass `max` at all', () => {
    const asOf = day(2024, 6, 1)
    const corpus = ['alpha', 'bravo', 'charlie', 'delta', 'echo'].flatMap((actorId, i) => [
      storedEvent(actorId, 'commit', `commit ${i} touching the parser`, day(2024, 1, 1 + i * 10)),
      storedEvent(actorId, 'release', `publishes release ${i}.0.0`, asOf),
    ])
    const ranked = rankCandidates(corpus, asOf)

    // Every other test in the suite (existing and this file) passes `max` explicitly, which never
    // exercises the `opts.max ?? MAX_CANDIDATES` fallback. Omitting it here does.
    const { actorIds } = selectCandidates(ranked, { mustInclude: ranked[2]!.actorId })
    expect(actorIds).toHaveLength(MAX_CANDIDATES)
    expect(actorIds[0]).toBe(ranked[2]!.actorId)
  })

  it('returns everyone once, not fewer, when max exceeds the number of actors in memory', () => {
    const asOf = day(2024, 6, 1)
    const corpus = ['alpha', 'bravo', 'charlie', 'delta', 'echo'].flatMap((actorId, i) => [
      storedEvent(actorId, 'commit', `commit ${i} touching the parser`, day(2024, 1, 1 + i * 10)),
      storedEvent(actorId, 'release', `publishes release ${i}.0.0`, asOf),
    ])
    const ranked = rankCandidates(corpus, asOf)
    const { actorIds } = selectCandidates(ranked, { max: 10 })
    expect(actorIds).toHaveLength(5)
    expect(new Set(actorIds).size).toBe(5)
  })
})

describe('rankCandidates tie-break', () => {
  it('breaks equal scores on actor id, deterministically', () => {
    // Two actors with byte-for-byte identical event shapes (same kind, same content, same day)
    // score identically on every term — canShip, escalation, buildConcentration, newness and
    // pressure are all functions of an actor's OWN history, and neither actor here has a privilege
    // change, a release, or build-shaped commits. Only the `a.actorId.localeCompare(b.actorId)`
    // tiebreak in rankCandidates can decide their order, so this is the only test that can fail if
    // that tiebreak is ever removed or reversed — without it, candidate order (and therefore which
    // accounts spend a model call) would depend on object insertion order rather than being stable.
    const asOf = day(2024, 6, 1)
    const corpus = [
      storedEvent('bbb-actor', 'commit', 'ordinary portability fix', asOf),
      storedEvent('aaa-actor', 'commit', 'ordinary portability fix', asOf),
    ]
    const ranked = rankCandidates(corpus, asOf)
    expect(ranked[0]!.score).toBe(ranked[1]!.score)
    expect(ranked.map((c) => c.actorId)).toEqual(['aaa-actor', 'bbb-actor'])
  })

  it('does not divide by zero when custom weights sum to zero', () => {
    // rankCandidates divides by `Object.values(weights).reduce(...) || 1` specifically to survive
    // this. Nobody ships this configuration, but the whole point of exporting CandidateWeights is
    // that a reader can re-weight the terms (see the file-level comment on candidate selection) —
    // and "re-weight" includes zeroing everything out by mistake.
    const asOf = day(2024, 6, 1)
    const corpus = [storedEvent('solo', 'commit', 'ordinary fix', day(2024, 1, 1))]
    const zeroWeights = { canShip: 0, escalation: 0, buildConcentration: 0, newness: 0, pressure: 0 }
    const ranked = rankCandidates(corpus, asOf, zeroWeights)
    expect(ranked[0]!.score).toBe(0)
    expect(Number.isFinite(ranked[0]!.score)).toBe(true)
  })

  it('scores commit access without a shipped release as a partial ability to ship (0.7)', () => {
    // canShip is a three-way ternary: 1 (has shipped a release), 0.7 (has privilege but never
    // shipped), 0 (neither). Every other test in this suite and in tests/agent.test.ts uses actors
    // who either ship or do neither — the middle rung was never exercised.
    const asOf = day(2024, 6, 1)
    const corpus = [
      storedEvent('co-maintainer', 'commit', 'fixes a parser bug', day(2024, 1, 1)),
      storedEvent('co-maintainer', 'maintainer_change', 'granted commit access', day(2024, 1, 5)),
    ]
    const ranked = rankCandidates(corpus, asOf)
    expect(ranked[0]!.terms.canShip).toBeCloseTo(0.7)
  })
})

describe('composeArcPrompt: recent-section omission wording', () => {
  const SIGNALS: ActorSignals = {
    actorId: 'attacker',
    firstSeen: day(2021, 10, 1),
    tenureDays: 900,
    totalEvents: 40,
    commits: 30,
    emails: 6,
    releases: 3,
    privilegeChanges: 1,
    buildSystemShare: 0.6,
    daysFromFirstActivityToPrivilege: 500,
    producesReleases: true,
  }

  it('reports its own accurate count, independent of the trajectory section next to it', () => {
    // The existing bounded-trajectory tests (tests/agent.test.ts) only ever pass a SHORT `recent`
    // array — the omission wording is asserted only for the "Full trajectory" section. The "Recent
    // activity" section computes its own `total` (`input.recent.length`) and its own `omitted`
    // count independently; a copy-paste bug that let one section's numbers leak into the other's
    // wording would not be caught by exercising just one of the two sections.
    const recent = Array.from({ length: 150 }, (_, i) =>
      storedEvent('attacker', 'commit', `recent item ${i}`, day(2024, 2, 1)),
    )
    const history = Array.from({ length: 5 }, (_, i) =>
      storedEvent('attacker', 'commit', `old item ${i}`, day(2020, 1, 1)),
    )

    const composed = composeArcPrompt({
      windowDays: 90,
      signals: SIGNALS,
      pressureActors: [],
      recent,
      history,
    })

    // Exact wording, not "contains a number somewhere": 150 recent, cap 120, so 30 dropped.
    expect(composed).toContain(
      `Recent activity (last 90 days) — showing the ${MAX_PROMPT_EVENTS} most recent of 150; 30 older omitted:`,
    )
    // The short history has no omission at all — its own line must say so plainly, not inherit the
    // recent section's "30 older omitted".
    expect(composed).toContain('Full trajectory:')
    expect(composed).not.toContain('Full trajectory —')

    // Recency wins the tie (tailWithCount keeps the tail): items 30..149 survive, 0..29 do not.
    expect(composed).toContain('recent item 30')
    expect(composed).toContain('recent item 149')
    expect(composed).not.toContain('recent item 29')

    const keptLines = composed
      .split('\n')
      .filter((l) => /^- \d{4}-\d{2}-\d{2} \[commit\] recent item \d+$/.test(l))
    expect(keptLines).toHaveLength(MAX_PROMPT_EVENTS)
  })

  it('renders "unknown" rather than crashing when the actor has no first-seen date', () => {
    // signals.firstSeen is only null for an actor actorSignals has literally never seen — not a
    // scenario the real pipeline produces (an arc is always built for an actor with at least one
    // event), but composeArcPrompt is a pure exported function and this is the one input shape none
    // of the fixtures above ever construct.
    const composed = composeArcPrompt({
      windowDays: 90,
      signals: { ...SIGNALS, firstSeen: null },
      pressureActors: [],
      recent: [],
      history: [],
    })
    expect(composed).toContain('Actor first public activity: unknown')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Part B — assess()/runReplay(), with the memory layer mocked out.
//
// Nothing in tests/agent.test.ts calls runReplay in-process; the only prior coverage of this code
// was tests/integration.test.ts, gated on a live cluster. This is the offline equivalent.
// ─────────────────────────────────────────────────────────────────────────────

const PKG = 'branch-test-pkg'
const THRESHOLDS: Thresholds = { holdAt: 0.6, minMargin: 0.05 }

const HIGH_SIMILARITY_MATCHES = [
  { id: 'known-takeover', packageId: 'xz-utils', label: 'takeover' as const, source: 'seed', similarity: 0.9 },
  { id: 'known-benign', packageId: 'curl', label: 'benign' as const, source: 'seed', similarity: 0.3 },
]

const LOW_SIMILARITY_MATCHES = [
  { id: 'far-takeover', packageId: 'xz-utils', label: 'takeover' as const, source: 'seed', similarity: 0.15 },
  { id: 'close-benign', packageId: 'curl', label: 'benign' as const, source: 'seed', similarity: 0.85 },
]

/** An arc/explain/neighbour environment good enough that buildArc and assess run to completion. */
function installDefaultMemoryMocks(): void {
  vi.mocked(memory.arcWindow).mockImplementation((asOf, windowDays, eventCount) => ({
    windowStart: new Date(asOf.getTime() - windowDays * 86_400_000),
    windowEnd: asOf,
    eventCount,
  }))
  vi.mocked(memory.ingestEvent).mockImplementation(
    async (event) => `evt-${event.actorId}-${event.occurredAt}`,
  )
  vi.mocked(memory.upsertActorArc).mockResolvedValue('arc-row-id')
  vi.mocked(memory.explainScoped).mockResolvedValue({
    plan: 'stub plan',
    prefixScoped: true,
    usedVectorIndex: true,
  })
  vi.mocked(memory.scopedNeighbours).mockResolvedValue([])
  vi.mocked(memory.resetPackage).mockResolvedValue(undefined)
}

function eventStep(steps: Step[], index: number): Extract<Step, { type: 'event' }> {
  const found = steps.filter((s): s is Extract<Step, { type: 'event' }> => s.type === 'event')[index]
  if (!found) throw new Error(`no event step at index ${index}`)
  return found
}

function only<T extends Step['type']>(steps: Step[], type: T): Extract<Step, { type: T }>[] {
  return steps.filter((s): s is Extract<Step, { type: T }> => s.type === type)
}

beforeEach(() => {
  vi.clearAllMocks()
  installDefaultMemoryMocks()
})

describe('runReplay: hold stops further re-deciding, but ingestion continues', () => {
  it('assesses only the release, holds on it, and never re-decides the second release', async () => {
    const sneakyHistory: StoredEvent[] = [
      storedEvent('sneaky', 'commit', 'small portability fix', day(2023, 1, 1), PKG),
      storedEvent('sneaky', 'release', 'publishes the 9.9.9 release tarball', day(2023, 1, 10), PKG),
    ]
    vi.mocked(memory.packageHistory).mockResolvedValue(sneakyHistory)
    vi.mocked(memory.actorHistory).mockResolvedValue(sneakyHistory)
    vi.mocked(memory.matchPlaybook).mockResolvedValue(HIGH_SIMILARITY_MATCHES)
    vi.mocked(memory.commitHold).mockResolvedValue({
      holdId: 'hold-xyz',
      advisoryId: 'adv-1',
      auditId: 'aud-1',
      committedAt: day(2023, 1, 10),
      writes: ['INSERT release_hold', "UPDATE trust_state -> 'held'"],
    })

    const events: TimelineEvent[] = [
      { packageId: PKG, actorId: 'sneaky', kind: 'commit', content: 'small portability fix', occurredAt: '2023-01-01T00:00:00Z' },
      { packageId: PKG, actorId: 'sneaky', kind: 'release', content: 'publishes the 9.9.9 release tarball', occurredAt: '2023-01-10T00:00:00Z' },
      { packageId: PKG, actorId: 'sneaky', kind: 'release', content: 'publishes the 9.9.10 release tarball', occurredAt: '2023-01-20T00:00:00Z' },
    ]

    const steps: Step[] = []
    const summary = await runReplay(
      { packageId: PKG, windowDays: 90, thresholds: THRESHOLDS, events, maxCandidates: 1 },
      (s) => {
        steps.push(s)
      },
    )

    // The commit is not a release: it must never trigger an assessment.
    // The second release lands after the hold: `summary.holdId` is already set, so the
    // `event.kind !== 'release' || summary.holdId` guard in runReplay must short-circuit it too.
    // Both are visible the same way: packageHistory/matchPlaybook, which only assess() calls, ran
    // exactly once even though three events (one commit, two releases) were ingested.
    expect(memory.packageHistory).toHaveBeenCalledTimes(1)
    expect(memory.matchPlaybook).toHaveBeenCalledTimes(1)
    expect(memory.actorHistory).toHaveBeenCalledTimes(1)
    expect(memory.commitHold).toHaveBeenCalledTimes(1)

    expect(only(steps, 'decision')).toHaveLength(1)
    expect(only(steps, 'decision')[0]!.decision.hold).toBe(true)
    expect(only(steps, 'hold')).toHaveLength(1)
    expect(only(steps, 'hold')[0]!.holdId).toBe('hold-xyz')

    expect(summary.holdId).toBe('hold-xyz')
    // All three events are still in memory — a hold blocks the RELEASE, not the historical record.
    expect(summary.ingested).toBe(3)

    // The event that actually caused the hold was ingested BEFORE the hold existed; the one after
    // it was ingested knowing a hold was already in force. Getting this backwards would mean the
    // demo's own "afterHold" badge lies about which events happened under an active hold.
    expect(eventStep(steps, 1).afterHold).toBe(false)
    expect(eventStep(steps, 2).afterHold).toBe(true)
  })

  it('never calls commitHold when similarity is below threshold — an allow leaves no hold row', async () => {
    const quietHistory: StoredEvent[] = [
      storedEvent('quiet', 'release', 'publishes the 1.0.0 release tarball', day(2023, 3, 1), PKG),
    ]
    vi.mocked(memory.packageHistory).mockResolvedValue(quietHistory)
    vi.mocked(memory.actorHistory).mockResolvedValue(quietHistory)
    vi.mocked(memory.matchPlaybook).mockResolvedValue(LOW_SIMILARITY_MATCHES)

    const events: TimelineEvent[] = [
      { packageId: PKG, actorId: 'quiet', kind: 'release', content: 'publishes the 1.0.0 release tarball', occurredAt: '2023-03-01T00:00:00Z' },
    ]
    const steps: Step[] = []
    const summary = await runReplay(
      { packageId: PKG, windowDays: 90, thresholds: THRESHOLDS, events, maxCandidates: 1 },
      (s) => {
        steps.push(s)
      },
    )

    expect(memory.commitHold).not.toHaveBeenCalled()
    expect(only(steps, 'hold')).toHaveLength(0)
    expect(only(steps, 'decision')[0]!.decision.hold).toBe(false)
    expect(summary.holdId).toBeNull()
    // The decision line still fires on allow — that is the point of C4 (see src/agent.ts comment on
    // `decision.made`), and this is the one place a unit test can watch it happen without a cluster.
    expect(summary.decision?.hold).toBe(false)
  })

  it('abstains — rather than crashing — when the playbook has no takeover-labelled arc at all', async () => {
    // decide.ts documents this explicitly: an empty match set is ambiguous between "empty playbook"
    // and "wrong embedding model", and either way it must abstain, not hold. `decision.matched` is
    // null on this path, which is the one case where `decision.matched?.packageId ?? null` in the
    // decision.made log line actually takes its `null` branch — every other test in this file
    // supplies a takeover-labelled match (even a distant one), so this was never reached before.
    const history: StoredEvent[] = [
      storedEvent('nobody', 'release', 'publishes the 1.0.0 release tarball', day(2023, 4, 1), PKG),
    ]
    vi.mocked(memory.packageHistory).mockResolvedValue(history)
    vi.mocked(memory.actorHistory).mockResolvedValue(history)
    vi.mocked(memory.matchPlaybook).mockResolvedValue([
      { id: 'b1', packageId: 'curl', label: 'benign', source: 'seed', similarity: 0.4 },
    ])

    const events: TimelineEvent[] = [
      { packageId: PKG, actorId: 'nobody', kind: 'release', content: 'publishes the 1.0.0 release tarball', occurredAt: '2023-04-01T00:00:00Z' },
    ]
    const summary = await runReplay(
      { packageId: PKG, windowDays: 90, thresholds: THRESHOLDS, events, maxCandidates: 1 },
      () => {},
    )

    expect(summary.decision?.hold).toBe(false)
    expect(summary.decision?.matched).toBeNull()
    expect(summary.decision?.explanation).toMatch(/No takeover-labelled arc was retrieved/)
    expect(memory.commitHold).not.toHaveBeenCalled()
  })

  it('also abstains, with no benign neighbour to contrast against, when the playbook is all takeover arcs', async () => {
    // The mirror image of the previous test, and just as real a misconfiguration: a playbook with
    // takeover-labelled arcs but no benign ones at all leaves `decision.nearestBenign` null. decide()
    // treats "nothing to contrast against" as un-evaluable regardless of the raw similarity (see the
    // `contrastable` comment in src/decide.ts) — a two-sided gate cannot become one-sided just
    // because half its evidence is missing. This is the only scenario in the suite where
    // `nearestBenignPackageId: decision.nearestBenign?.packageId ?? null` takes its `null` branch.
    const history: StoredEvent[] = [
      storedEvent('nobody', 'release', 'publishes the 1.0.0 release tarball', day(2023, 4, 1), PKG),
    ]
    vi.mocked(memory.packageHistory).mockResolvedValue(history)
    vi.mocked(memory.actorHistory).mockResolvedValue(history)
    vi.mocked(memory.matchPlaybook).mockResolvedValue([
      { id: 't1', packageId: 'xz-utils', label: 'takeover', source: 'seed', similarity: 0.95 },
    ])

    const events: TimelineEvent[] = [
      { packageId: PKG, actorId: 'nobody', kind: 'release', content: 'publishes the 1.0.0 release tarball', occurredAt: '2023-04-01T00:00:00Z' },
    ]
    const summary = await runReplay(
      { packageId: PKG, windowDays: 90, thresholds: THRESHOLDS, events, maxCandidates: 1 },
      () => {},
    )

    // High raw similarity to a known takeover shape is NOT enough on its own — the whole point of
    // the two-sided design (see the C? margin comment in src/decide.ts).
    expect(summary.decision?.hold).toBe(false)
    expect(summary.decision?.nearestBenign).toBeNull()
    expect(memory.commitHold).not.toHaveBeenCalled()
  })
})

describe('structural signals are evidence, not votes — a runtime pin, not just a source grep', () => {
  // tests/agent.test.ts already asserts, by reading src/decide.ts, that decide() never references
  // Candidate/rankCandidates/signals. That pins the CLAIM in the source. It does not prove that
  // assess() actually behaves that way at runtime. This test builds an actor whose structural
  // signals are about as damning as the corpus vocabulary can make them — fast escalation to a
  // privileged role, 100% build/CI-concentrated commits, a release already shipped, and a
  // no-code account that pushed for exactly this handover and then vanished — and then makes the
  // vector retrieval say "not similar to anything we've seen before". If evidence ever leaked into
  // the hold decision, this is the shape that would flip it to a hold; it doesn't.
  it('does not hold on a suspicious-looking actor when retrieval finds no resemblance to a known takeover', async () => {
    const asOf = day(2023, 1, 10)
    const sneakyHistory: StoredEvent[] = [
      storedEvent('sneaky', 'commit', 'reworks the autoconf build system and CI matrix', day(2023, 1, 1), PKG),
      storedEvent('sneaky', 'maintainer_change', 'granted commit access as co-maintainer', day(2023, 1, 5), PKG),
      storedEvent('sneaky', 'release', 'publishes the 9.9.9 release tarball', asOf, PKG),
    ]
    const pressurer = storedEvent(
      'pressurer',
      'email',
      'we need a new maintainer to take over — lasse is too slow',
      day(2022, 12, 20),
      PKG,
    )
    vi.mocked(memory.packageHistory).mockResolvedValue([...sneakyHistory, pressurer])
    vi.mocked(memory.actorHistory).mockResolvedValue(sneakyHistory)
    // Nothing here resembles anything the playbook has seen: nearest takeover is far away, nearest
    // benign is close. Two-sided decide() must refuse on similarity alone.
    vi.mocked(memory.matchPlaybook).mockResolvedValue(LOW_SIMILARITY_MATCHES)

    const events: TimelineEvent[] = [
      { packageId: PKG, actorId: 'sneaky', kind: 'release', content: 'publishes the 9.9.9 release tarball', occurredAt: asOf.toISOString() },
    ]
    const steps: Step[] = []
    const summary = await runReplay(
      { packageId: PKG, windowDays: 90, thresholds: THRESHOLDS, events, maxCandidates: 1 },
      (s) => {
        steps.push(s)
      },
    )

    // First, prove the evidence really was as damning as the test claims — otherwise "it didn't
    // hold" would be meaningless (there'd have been nothing to ignore).
    const arc = only(steps, 'arc')[0]!
    expect(arc.evidence).toContain('Trust escalated to a privileged role 4 days after first public activity.')
    expect(arc.evidence).toContain(
      "100% of this actor's commits touch build or CI machinery rather than library code — the " +
        'layer that ships in release tarballs but is least reviewed.',
    )
    expect(arc.evidence).toContain(
      '1 account(s) with no code contributions (pressurer) argued for the maintainer handover and ' +
        'then stopped participating.',
    )

    // Then prove none of it moved the decision: the gate stayed open.
    expect(summary.decision?.hold).toBe(false)
    expect(memory.commitHold).not.toHaveBeenCalled()
  })
})

describe('choosing the strongest of several assessed candidates (`stronger`)', () => {
  // With maxCandidates > 1, assess() builds an independent arc/decision per candidate and commits
  // only the winner's hold — see the `stronger` doc comment in src/agent.ts. None of the tests
  // above ever assess more than one candidate (maxCandidates was pinned to 1 throughout), so this
  // comparison function had no coverage at all. Two actors, 'shipper' (the release's own actor,
  // always assessed) and 'other' (the next-ranked candidate), are assessed together in every test
  // below; `matchPlaybook` is scripted per call, in assessment order, to control each candidate's
  // own decision independently of the other's.
  const asOf = day(2023, 5, 1)
  const shipperEvent = storedEvent('shipper', 'release', 'publishes the 5.0.0 release tarball', asOf, PKG)
  const otherEvent = storedEvent('other', 'commit', 'ordinary portability fix', day(2023, 1, 1), PKG)

  beforeEach(() => {
    vi.mocked(memory.packageHistory).mockResolvedValue([shipperEvent, otherEvent])
    vi.mocked(memory.actorHistory).mockImplementation(async (_pkg, actorId) =>
      actorId === 'shipper' ? [shipperEvent] : [otherEvent],
    )
    vi.mocked(memory.commitHold).mockResolvedValue({
      holdId: 'hold-winner',
      advisoryId: 'adv-1',
      auditId: 'aud-1',
      committedAt: asOf,
      writes: ['INSERT release_hold'],
    })
  })

  const events: TimelineEvent[] = [
    { packageId: PKG, actorId: 'shipper', kind: 'release', content: 'publishes the 5.0.0 release tarball', occurredAt: asOf.toISOString() },
  ]

  it('a hold beats an allow, regardless of assessment order', async () => {
    // shipper (assessed first, mustInclude) allows; other (assessed second) holds.
    vi.mocked(memory.matchPlaybook)
      .mockResolvedValueOnce(LOW_SIMILARITY_MATCHES)
      .mockResolvedValueOnce(HIGH_SIMILARITY_MATCHES)

    const summary = await runReplay(
      { packageId: PKG, windowDays: 90, thresholds: THRESHOLDS, events, maxCandidates: 2 },
      () => {},
    )
    expect(summary.assessedActors).toEqual(['shipper', 'other'])
    expect(summary.assessedActor).toBe('other')
    expect(summary.decision?.hold).toBe(true)
    // Only the winner's hold is committed — never one row per candidate that individually holds.
    expect(memory.commitHold).toHaveBeenCalledTimes(1)
  })

  it('between two holds, the higher similarity to the known takeover shape wins', async () => {
    const lowerHold = [
      { id: 't1', packageId: 'xz-utils', label: 'takeover' as const, source: 'seed', similarity: 0.9 },
      { id: 'b1', packageId: 'curl', label: 'benign' as const, source: 'seed', similarity: 0.3 },
    ]
    const higherHold = [
      { id: 't2', packageId: 'xz-utils', label: 'takeover' as const, source: 'seed', similarity: 0.95 },
      { id: 'b2', packageId: 'curl', label: 'benign' as const, source: 'seed', similarity: 0.3 },
    ]
    vi.mocked(memory.matchPlaybook).mockResolvedValueOnce(lowerHold).mockResolvedValueOnce(higherHold)

    const summary = await runReplay(
      { packageId: PKG, windowDays: 90, thresholds: THRESHOLDS, events, maxCandidates: 2 },
      () => {},
    )
    // 'other' (0.95) beats 'shipper' (0.9) purely on similarity — both hold.
    expect(summary.assessedActor).toBe('other')
    expect(memory.commitHold).toHaveBeenCalledTimes(1)
  })

  it('between two holds tied on similarity, the wider margin from the nearest benign arc wins', async () => {
    // Equal similarity to the takeover shape (0.9 both) — `stronger` must fall through to margin.
    const widerMargin = [
      { id: 't1', packageId: 'xz-utils', label: 'takeover' as const, source: 'seed', similarity: 0.9 },
      { id: 'b1', packageId: 'curl', label: 'benign' as const, source: 'seed', similarity: 0.3 }, // margin .6
    ]
    const narrowerMargin = [
      { id: 't2', packageId: 'xz-utils', label: 'takeover' as const, source: 'seed', similarity: 0.9 },
      { id: 'b2', packageId: 'curl', label: 'benign' as const, source: 'seed', similarity: 0.5 }, // margin .4
    ]
    vi.mocked(memory.matchPlaybook)
      .mockResolvedValueOnce(widerMargin) // shipper: margin .6
      .mockResolvedValueOnce(narrowerMargin) // other: margin .4

    const summary = await runReplay(
      { packageId: PKG, windowDays: 90, thresholds: THRESHOLDS, events, maxCandidates: 2 },
      () => {},
    )
    // shipper's wider separation from the nearest ordinary-contributor arc wins the tie, even though
    // it was assessed first — this is not "first candidate wins ties", it is a real margin compare.
    expect(summary.assessedActor).toBe('shipper')
    expect(memory.commitHold).toHaveBeenCalledTimes(1)
  })
})

describe('runReplay: the reset flag', () => {
  it('resets the package by default and says so in the emitted log', async () => {
    const steps: Step[] = []
    await runReplay({ packageId: PKG, windowDays: 90, thresholds: THRESHOLDS, events: [] }, (s) => {
      steps.push(s)
    })
    expect(memory.resetPackage).toHaveBeenCalledWith(PKG)
    expect(only(steps, 'log')[0]!.message).toBe(`Memory reset for ${PKG}.`)
  })

  it('skips the destructive reset when reset:false — for replaying into a cluster that already holds the corpus', async () => {
    const steps: Step[] = []
    await runReplay(
      { packageId: PKG, windowDays: 90, thresholds: THRESHOLDS, events: [], reset: false },
      (s) => {
        steps.push(s)
      },
    )
    expect(memory.resetPackage).not.toHaveBeenCalled()
    expect(only(steps, 'log')).toHaveLength(0)
  })
})
