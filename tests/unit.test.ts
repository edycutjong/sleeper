import { describe, expect, it } from 'vitest'
import { offlineEmbed } from '../src/embeddings.js'
import { fromVector, toVector } from '../src/db.js'
import { arcWindow, hasPrefixSpans } from '../src/memory.js'
import { extractVersion } from '../src/agent.js'
import { loadSynthetic, loadTimeline } from '../src/corpus.js'

describe('offlineEmbed', () => {
  it('produces the configured dimensionality', () => {
    expect(offlineEmbed('anything')).toHaveLength(1024)
  })

  it('is deterministic — the same text always gives the same vector', () => {
    expect(offlineEmbed('a slow trust acquisition arc')).toEqual(
      offlineEmbed('a slow trust acquisition arc'),
    )
  })

  it('is L2-normalised, so a dot product is a cosine similarity', () => {
    const v = offlineEmbed('maintainer hands over release signing authority')
    expect(Math.hypot(...v)).toBeCloseTo(1, 10)
  })

  it('survives empty input instead of emitting NaNs', () => {
    const v = offlineEmbed('')
    expect(v.every(Number.isFinite)).toBe(true)
    expect(Math.hypot(...v)).toBeCloseTo(1, 10)
  })

  it('scores related text above unrelated text', () => {
    const dot = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * b[i]!, 0)
    const probe = offlineEmbed('the maintainer handed over release signing authority')
    const related = offlineEmbed('release signing authority was handed to the new maintainer')
    const unrelated = offlineEmbed('the parser was rewritten to reduce allocations')
    expect(dot(probe, related)).toBeGreaterThan(dot(probe, unrelated))
  })
})

describe('vector wire format', () => {
  it('round-trips through the pgvector text literal', () => {
    const original = Array.from({ length: 1024 }, (_, i) => (i % 7) / 7)
    expect(fromVector(toVector(original))).toEqual(original)
  })

  it('rejects a vector of the wrong width rather than letting the INSERT fail opaquely', () => {
    expect(() => toVector([1, 2, 3])).toThrow(/expected 1024/)
  })
})

describe('hasPrefixSpans', () => {
  it('detects the real CockroachDB plan line', () => {
    expect(
      hasPrefixSpans(
        `• vector search\n  table: events@events_pkg_embedding_idx\n  prefix spans: [/'xz-utils' - /'xz-utils']`,
      ),
    ).toBe(true)
  })

  it('is false for an unscoped vector search', () => {
    expect(hasPrefixSpans('• vector search\n  table: takeover_playbook@idx\n  target count: 5')).toBe(
      false,
    )
  })

  it('is false for a full table scan', () => {
    expect(hasPrefixSpans('• scan\n  table: events@events_pkey\n  spans: FULL SCAN')).toBe(false)
  })
})

describe('arcWindow', () => {
  it('opens the window exactly windowDays before the assessment point', () => {
    const w = arcWindow(new Date('2024-02-24T00:00:00Z'), 90, 4)
    expect(w.windowStart.toISOString()).toBe('2023-11-26T00:00:00.000Z')
    expect(w.windowEnd.toISOString()).toBe('2024-02-24T00:00:00.000Z')
    expect(w.eventCount).toBe(4)
  })
})

describe('extractVersion', () => {
  it('pulls a semantic version out of release prose', () => {
    expect(extractVersion('Publishes the xz-utils 5.6.0 release tarball.', 'x')).toBe('5.6.0')
  })

  it('accepts two-part versions', () => {
    expect(extractVersion('tags 5.4 and moves on', 'x')).toBe('5.4')
  })

  it('falls back when there is no version to find', () => {
    expect(extractVersion('publishes a release', '2024-02-24')).toBe('2024-02-24')
  })
})

describe('bundled corpora', () => {
  const timeline = loadTimeline()
  const synthetic = loadSynthetic()

  it('loads the xz timeline with every event mapped to the package', () => {
    expect(timeline.packageId).toBe('xz-utils')
    expect(timeline.events.length).toBeGreaterThanOrEqual(20)
    expect(timeline.events.every((e) => e.packageId === 'xz-utils')).toBe(true)
  })

  it('gives every event a parseable timestamp and a known actor', () => {
    for (const e of timeline.events) {
      expect(Number.isNaN(Date.parse(e.occurredAt))).toBe(false)
      expect(timeline.actors[e.actorId]).toBeDefined()
    }
  })

  it('contains the 5.6.0 release that the hold must fire on', () => {
    const releases = timeline.events.filter((e) => e.kind === 'release')
    expect(releases.some((e) => extractVersion(e.content, '') === '5.6.0')).toBe(true)
  })

  it('keeps the playbook and held-out splits disjoint', () => {
    const playbook = new Set(synthetic.playbook.map((a) => a.id))
    expect(synthetic.heldout.some((a) => playbook.has(a.id))).toBe(false)
  })

  it('never reuses the same arc text across the two splits', () => {
    const texts = new Set(synthetic.playbook.map((a) => a.arc_summary))
    expect(synthetic.heldout.some((a) => texts.has(a.arc_summary))).toBe(false)
  })

  it('balances both splits across labels so the metrics are not trivially winnable', () => {
    for (const split of [synthetic.playbook, synthetic.heldout]) {
      const takeover = split.filter((a) => a.label === 'takeover').length
      expect(takeover).toBe(split.length - takeover)
      expect(takeover).toBeGreaterThanOrEqual(3)
    }
  })
})
