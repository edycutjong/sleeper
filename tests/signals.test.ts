import { describe, expect, it } from 'vitest'
import { actorSignals, evidenceLines, pressureAccounts } from '../src/signals.js'
import type { StoredEvent } from '../src/memory.js'

type EventSpec = { actorId: string; occurredAt: string; kind?: string; content?: string }

function ev(spec: EventSpec): StoredEvent {
  return {
    id: `${spec.actorId}-${spec.occurredAt}`,
    packageId: 'pkg',
    actorId: spec.actorId,
    kind: spec.kind ?? 'commit',
    content: spec.content ?? 'a routine change',
    occurredAt: new Date(spec.occurredAt),
    sourceUrl: null,
  }
}

const ASOF = new Date('2024-02-24T00:00:00Z')

describe('actorSignals', () => {
  const events: StoredEvent[] = [
    ev({ actorId: 'newcomer', occurredAt: '2022-01-01T00:00:00Z', content: 'small portability fix' }),
    ev({ actorId: 'newcomer', occurredAt: '2022-06-01T00:00:00Z', content: 'reworks the autoconf build system' }),
    ev({ actorId: 'newcomer', occurredAt: '2022-08-01T00:00:00Z', kind: 'maintainer_change', content: 'named as co-maintainer' }),
    ev({ actorId: 'newcomer', occurredAt: '2023-01-01T00:00:00Z', kind: 'release', content: 'publishes 1.2.0' }),
    ev({ actorId: 'other', occurredAt: '2022-02-01T00:00:00Z' }),
  ]

  it('measures tenure from the actor’s own first event', () => {
    const s = actorSignals(events, 'newcomer', ASOF)
    expect(s.firstSeen?.toISOString().slice(0, 10)).toBe('2022-01-01')
    expect(s.tenureDays).toBe(784)
  })

  it('counts only the named actor’s events', () => {
    expect(actorSignals(events, 'newcomer', ASOF).totalEvents).toBe(4)
    expect(actorSignals(events, 'other', ASOF).totalEvents).toBe(1)
  })

  it('measures how fast trust escalated', () => {
    expect(actorSignals(events, 'newcomer', ASOF).daysFromFirstActivityToPrivilege).toBe(212)
  })

  it('scores the share of commits touching build machinery', () => {
    // 2 commits, 1 of which is an autoconf change.
    expect(actorSignals(events, 'newcomer', ASOF).buildSystemShare).toBeCloseTo(0.5)
  })

  it('notices when the actor produces releases', () => {
    expect(actorSignals(events, 'newcomer', ASOF).producesReleases).toBe(true)
    expect(actorSignals(events, 'other', ASOF).producesReleases).toBe(false)
  })

  it('never sees past the assessment point', () => {
    const early = actorSignals(events, 'newcomer', new Date('2022-03-01T00:00:00Z'))
    expect(early.totalEvents).toBe(1)
    expect(early.producesReleases).toBe(false)
    expect(early.daysFromFirstActivityToPrivilege).toBeNull()
  })

  it('returns a zeroed profile for an actor with no history', () => {
    const s = actorSignals(events, 'ghost', ASOF)
    expect(s.firstSeen).toBeNull()
    expect(s.tenureDays).toBe(0)
    expect(s.buildSystemShare).toBe(0)
  })
})

describe('pressureAccounts', () => {
  const events: StoredEvent[] = [
    ev({ actorId: 'pressure-1', occurredAt: '2022-04-01T00:00:00Z', kind: 'email', content: 'you should hand over maintainer duties' }),
    ev({ actorId: 'pressure-1', occurredAt: '2022-05-01T00:00:00Z', kind: 'email', content: 'still no progress, name a successor' }),
    ev({ actorId: 'contributor', occurredAt: '2022-04-02T00:00:00Z', kind: 'email', content: 'please review my patch' }),
    ev({ actorId: 'coder', occurredAt: '2022-04-03T00:00:00Z', kind: 'commit', content: 'hand over maintainer duties' }),
  ]

  it('flags accounts that only ever argue for a handover', () => {
    const found = pressureAccounts(events, ASOF)
    expect(found.map((p) => p.actorId)).toEqual(['pressure-1'])
    expect(found[0]?.events).toBe(2)
  })

  it('ignores email accounts that are not pushing for control', () => {
    expect(pressureAccounts(events, ASOF).some((p) => p.actorId === 'contributor')).toBe(false)
  })

  it('ignores accounts that contribute code, however they talk', () => {
    expect(pressureAccounts(events, ASOF).some((p) => p.actorId === 'coder')).toBe(false)
  })

  it('respects the assessment point', () => {
    expect(pressureAccounts(events, new Date('2022-03-01T00:00:00Z'))).toHaveLength(0)
    // Mid-campaign the account is already visible, but only its first message counts.
    expect(pressureAccounts(events, new Date('2022-04-15T00:00:00Z'))[0]?.events).toBe(1)
  })
})

describe('evidenceLines', () => {
  it('produces citable prose from the signals', () => {
    const signals = actorSignals(
      [
        ev({ actorId: 'a', occurredAt: '2022-01-01T00:00:00Z', content: 'edits the m4 macros' }),
        ev({ actorId: 'a', occurredAt: '2023-01-01T00:00:00Z', kind: 'release', content: 'ships 2.0' }),
      ],
      'a',
      ASOF,
    )
    const lines = evidenceLines(signals, [
      { actorId: 'ghost', events: 3, firstSeen: new Date('2022-02-01'), lastSeen: new Date('2022-03-01') },
    ])
    expect(lines.join('\n')).toMatch(/100% of this actor's commits touch build or CI/)
    expect(lines.join('\n')).toMatch(/signed release artifacts/)
    expect(lines.join('\n')).toMatch(/ghost/)
  })

  it('omits claims it has no evidence for', () => {
    const signals = actorSignals([ev({ actorId: 'a', occurredAt: '2024-01-01T00:00:00Z', content: 'docs typo' })], 'a', ASOF)
    const lines = evidenceLines(signals, []).join('\n')
    expect(lines).not.toMatch(/release artifacts/)
    expect(lines).not.toMatch(/argued for the maintainer handover/)
    expect(lines).not.toMatch(/build or CI machinery/)
  })
})

describe('an actor with no recorded events', () => {
  // A previous review pass called this branch unreachable and proposed silencing it with a coverage
  // ignore. It is reachable in production, which is why the test exists instead: SUSPECT_ACTOR
  // (config.suspectActorOverride) bypasses candidate ranking entirely in selectCandidates and is
  // used unchecked, so pointing it at an actor who is absent from the corpus — a typo, or an
  // exploratory "what if we suspected X" — lands exactly here.
  //
  // What the assertion is really protecting is the evidence line a packager reads. `firstSeen` is
  // null, and an unguarded `.toISOString()` on it would throw while composing the rationale for a
  // hold; the fallback has to say "unknown" and keep going.
  it('reports zero tenure and an unknown first-seen date rather than throwing', () => {
    const corpus: StoredEvent[] = [ev({ actorId: 'somebody-else', occurredAt: '2022-01-01T00:00:00Z' })]
    const s = actorSignals(corpus, 'nobody-by-that-name', ASOF)
    expect(s.firstSeen).toBeNull()
    expect(s.tenureDays).toBe(0)
    expect(s.totalEvents).toBe(0)

    // The whole point: composing evidence for an unknown actor must not throw on the null
    // firstSeen. Assert that before reading the lines, so a throw reports as this expectation
    // failing rather than as an error raised while building the fixture.
    expect(() => evidenceLines(s, [])).not.toThrow()
    const lines = evidenceLines(s, []).join('\n')
    expect(lines).toContain('0 recorded events')
    expect(lines).toContain('first seen unknown')
  })
})
