/**
 * Unit tests for src/corpus.ts — loading the bundled corpora and the calibrated thresholds.
 *
 * `node:fs` is mocked (delegating to the real implementation by default) so the error paths —
 * a missing thresholds file, a malformed JSON file — are reachable without deleting or corrupting
 * the actual files the rest of the suite depends on. Every "happy path" test below still exercises
 * the REAL data files by leaving the mock's default implementation in place, so a change to
 * data/xz-timeline.json, data/synthetic-arcs.json or data/thresholds.json that breaks the loader is
 * still caught here, not just the two error branches this file was written to close.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { existsSync as ExistsSync, readFileSync as ReadFileSync } from 'node:fs'

// `vi.mock`'s factory runs BEFORE this file's own top-level imports, so capturing the real
// `existsSync`/`readFileSync` via a normal `import { existsSync as real } from 'node:fs'` up here
// would actually capture THIS MOCK (imports are hoisted below `vi.mock` calls too) — that is a
// mock whose default implementation calls itself, i.e. infinite recursion the first time any test
// lets a call fall through to "real" behaviour. `vi.hoisted` plus the factory's `importOriginal`
// helper is what gets a reference to the genuine module, before it is replaced.
const state = vi.hoisted(() => ({
  existsSync: vi.fn<typeof ExistsSync>(),
  readFileSync: vi.fn<typeof ReadFileSync>(),
  // Populated from `importOriginal` inside the factory below, once, the first time the module is
  // resolved — this is the ONLY safe handle on the genuine functions, since any `import … from
  // 'node:fs'` written in this file (after `vi.mock` runs) would resolve to the mock, not reality.
  actualExistsSync: undefined as unknown as typeof ExistsSync,
  actualReadFileSync: undefined as unknown as typeof ReadFileSync,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  state.actualExistsSync = actual.existsSync
  state.actualReadFileSync = actual.readFileSync
  state.existsSync.mockImplementation(actual.existsSync)
  state.readFileSync.mockImplementation(actual.readFileSync)
  return {
    ...actual,
    existsSync: (...args: Parameters<typeof ExistsSync>) => state.existsSync(...args),
    readFileSync: (...args: Parameters<typeof ReadFileSync>) => state.readFileSync(...args),
  }
})

const mockExistsSync = state.existsSync
const mockReadFileSync = state.readFileSync

import { DATA_DIR, loadSynthetic, loadThresholds, loadTimeline, THRESHOLDS_PATH } from '../src/corpus.js'
import { FALLBACK_THRESHOLDS } from '../src/decide.js'

beforeEach(() => {
  // Restored before every test, so a test that installs a one-off throw/return does not leak into
  // its sibling — and so tests that never touch the mocks still exercise the real filesystem.
  mockExistsSync.mockImplementation(state.actualExistsSync)
  mockReadFileSync.mockImplementation(state.actualReadFileSync)
  // Call history is cumulative across tests unless cleared explicitly — needed for the "did this
  // even attempt a read" assertion below to mean anything.
  mockExistsSync.mockClear()
  mockReadFileSync.mockClear()
})

describe('loadTimeline', () => {
  it('loads the real bundled xz corpus, mapping every event onto the package', () => {
    const timeline = loadTimeline()
    expect(timeline.packageId).toBe('xz-utils')
    expect(timeline.events.length).toBeGreaterThan(0)
    expect(timeline.events.every((e) => e.packageId === 'xz-utils')).toBe(true)
  })

  it('overrides the package id without touching per-event data', () => {
    const timeline = loadTimeline('override-pkg')
    expect(timeline.packageId).toBe('override-pkg')
    expect(timeline.events.every((e) => e.packageId === 'override-pkg')).toBe(true)
  })

  it('defaults a missing source_url to null rather than leaving it undefined', () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        package_id: 'synthetic-pkg',
        actors: { ghost: 'Ghost' },
        provenance: {},
        events: [
          {
            actor_id: 'ghost',
            kind: 'commit',
            occurred_at: '2024-01-01T00:00:00Z',
            content: 'no citation available',
          },
        ],
      }),
    )
    const timeline = loadTimeline()
    expect(timeline.events).toHaveLength(1)
    expect(timeline.events[0]!.sourceUrl).toBeNull()
  })

  it('keeps an explicit source_url rather than discarding it', () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        package_id: 'synthetic-pkg',
        actors: { ghost: 'Ghost' },
        provenance: {},
        events: [
          {
            actor_id: 'ghost',
            kind: 'commit',
            occurred_at: '2024-01-01T00:00:00Z',
            content: 'cited',
            source_url: 'https://example.com/commit/1',
          },
        ],
      }),
    )
    const timeline = loadTimeline()
    expect(timeline.events[0]!.sourceUrl).toBe('https://example.com/commit/1')
  })

  it('propagates a malformed corpus file rather than silently returning an empty timeline', () => {
    mockReadFileSync.mockReturnValue('{ this is not valid json')
    expect(() => loadTimeline()).toThrow(SyntaxError)
  })

  it('propagates a missing corpus file rather than masking it', () => {
    mockReadFileSync.mockImplementation(() => {
      const err = new Error(
        "ENOENT: no such file or directory, open 'xz-timeline.json'",
      ) as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    })
    expect(() => loadTimeline()).toThrow(/ENOENT/)
  })
})

describe('loadSynthetic', () => {
  it('loads the real bundled synthetic arcs, split into a playbook half and a held-out half', () => {
    const synthetic = loadSynthetic()
    expect(synthetic.playbook.length).toBeGreaterThan(0)
    expect(synthetic.heldout.length).toBeGreaterThan(0)
    // The split this file exists to keep honest — see the module docstring: blurring a held-out
    // arc into the playbook is how a reported recall number stops meaning anything.
    const playbookIds = new Set(synthetic.playbook.map((a) => a.id))
    expect(synthetic.heldout.every((a) => !playbookIds.has(a.id))).toBe(true)
  })

  it('propagates a malformed synthetic-arcs file rather than silently returning an empty split', () => {
    mockReadFileSync.mockReturnValue('{ not json either')
    expect(() => loadSynthetic()).toThrow(SyntaxError)
  })
})

describe('loadThresholds', () => {
  it('falls back to FALLBACK_THRESHOLDS, with no calibrated record, when the file does not exist', () => {
    mockExistsSync.mockReturnValue(false)
    const { thresholds, calibrated } = loadThresholds()
    expect(thresholds).toEqual(FALLBACK_THRESHOLDS)
    expect(calibrated).toBeNull()
    // The missing-file branch must not even attempt a read — that guard is the entire point of it.
    expect(mockReadFileSync).not.toHaveBeenCalled()
  })

  it('reports calibrated thresholds, with full provenance, when data/thresholds.json exists', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        holdAt: 0.7,
        minMargin: 0.03,
        fittedOn: 'playbook split only, leave-one-out',
        method: 'maximise balanced accuracy over candidate cut points',
        generatedWith: 'npm run calibrate',
      }),
    )
    const { thresholds, calibrated } = loadThresholds()
    // Only holdAt/minMargin are surfaced as the plain Thresholds the decision gate consumes —
    // the rest is provenance for the UI/bench to quote, not something `decide()` should see.
    expect(thresholds).toEqual({ holdAt: 0.7, minMargin: 0.03 })
    expect(calibrated).toMatchObject({
      holdAt: 0.7,
      minMargin: 0.03,
      fittedOn: 'playbook split only, leave-one-out',
      generatedWith: 'npm run calibrate',
    })
  })

  it('still reports calibrated thresholds when generatedWith is absent from the file', () => {
    // `generatedWith` is provenance for the UI/bench to say "how sure to be" about the numbers out
    // loud (see CalibratedThresholds) — but the loader does not validate the shape it reads back,
    // it passes the parsed object straight through. A hand-edited or pre-provenance thresholds.json
    // is real input this has to survive without inventing a value for the missing field.
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        holdAt: 0.5,
        minMargin: 0,
        fittedOn: 'playbook split only, leave-one-out',
        method: 'maximise balanced accuracy over candidate cut points',
      }),
    )
    const { thresholds, calibrated } = loadThresholds()
    expect(thresholds).toEqual({ holdAt: 0.5, minMargin: 0 })
    expect(calibrated?.fittedOn).toBe('playbook split only, leave-one-out')
    expect(calibrated?.generatedWith).toBeUndefined()
  })

  it('propagates a malformed thresholds.json rather than silently falling back to the default', () => {
    // Falling back on a CORRUPT file the same way it falls back on a MISSING one would hide a real
    // calibration failure behind the same numbers a fresh checkout ships with — that is worse than
    // a hard failure naming the file.
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('{ not json')
    expect(() => loadThresholds()).toThrow(SyntaxError)
  })

  it('exposes THRESHOLDS_PATH inside DATA_DIR, so a caller can name the exact file this module reads', () => {
    expect(THRESHOLDS_PATH.startsWith(DATA_DIR)).toBe(true)
    expect(THRESHOLDS_PATH.endsWith('thresholds.json')).toBe(true)
  })
})
