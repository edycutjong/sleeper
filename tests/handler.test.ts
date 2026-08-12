/**
 * Unit tests for the Lambda entry point (src/handler.ts) — the failure surface that
 * tests/server.test.ts does not reach.
 *
 * server.test.ts boots a real child process against a real cluster and is skipped without one; it
 * covers the happy path and cross-package routing. This file mocks every module handler.ts talks
 * to (config, corpus, agent, db, memory) so it runs with no network, no AWS credentials and no
 * cluster writes, and can therefore afford to poke the error taxonomy that a live cluster makes
 * awkward to provoke on demand: malformed payloads, a corrupt thresholds file, an unexpected
 * failure that must not leak its message, and the cold-start memo around assertPlaybookModel.
 *
 * log.js is deliberately left unmocked — it has no I/O beyond an optional stderr write this file
 * silences via SLEEPER_LOG=off, and using the real recordFailure()/newCorrId() is what makes the
 * "the raw error never reaches the body" assertions meaningful rather than tautological.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReplaySummary, Step } from '../src/agent.js'

vi.mock('../src/config.js', () => ({
  config: {
    packageId: 'config-default-package',
    arcWindowDays: 90,
    // Deliberately NOT any actor_id used in the payloads below, so a test asserting the webhook
    // path assessed the event's own actor actually fails honestly if the code regresses to reading
    // this instead (see the long comment on `suspectActor` in handler.ts's ingestHandler).
    suspectActorOverride: 'configured-actor-must-not-be-used-by-ingest',
    maxCandidates: 3,
  },
}))

vi.mock('../src/corpus.js', () => ({
  loadThresholds: vi.fn(),
  loadTimeline: vi.fn(),
}))

vi.mock('../src/agent.js', () => ({
  runReplay: vi.fn(),
}))

vi.mock('../src/db.js', () => ({
  closePool: vi.fn(),
}))

vi.mock('../src/memory.js', () => ({
  assertPlaybookModel: vi.fn(),
}))

import { config } from '../src/config.js'
import { loadThresholds, loadTimeline } from '../src/corpus.js'
import { runReplay } from '../src/agent.js'
import { closePool } from '../src/db.js'
import { assertPlaybookModel } from '../src/memory.js'
import {
  BadRequestError,
  ingestHandler,
  replayHandler,
  MAX_CONTENT_CHARS,
  type WebhookEvent,
} from '../src/handler.js'

const mockLoadThresholds = vi.mocked(loadThresholds)
const mockLoadTimeline = vi.mocked(loadTimeline)
const mockRunReplay = vi.mocked(runReplay)
const mockClosePool = vi.mocked(closePool)
const mockAssertPlaybookModel = vi.mocked(assertPlaybookModel)

const THRESHOLDS = { thresholds: { holdAt: 0.6, minMargin: 0.02 }, calibrated: null }

function okSummary(overrides: Partial<ReplaySummary> = {}): ReplaySummary {
  return {
    ingested: 1,
    assessedActor: null,
    assessedActors: [],
    holdId: null,
    heldAt: null,
    releaseVersion: null,
    decision: null,
    prefixScoped: false,
    decisionLatencyMs: null,
    ...overrides,
  }
}

function validPayload(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    actor_id: 'the-actual-committer',
    kind: 'commit',
    content: 'a perfectly ordinary commit message',
    occurred_at: '2024-01-01T00:00:00Z',
    ...overrides,
  }
}

function parseBody(res: { body: string }): any {
  return JSON.parse(res.body)
}

let previousLogEnv: string | undefined
beforeAll(() => {
  previousLogEnv = process.env.SLEEPER_LOG
  // recordFailure() is real in this file (see file header) and writes one stderr line per failure
  // test below — silenced so the suite's output stays readable, restored after so sibling files
  // that rely on the default sink are unaffected.
  process.env.SLEEPER_LOG = 'off'
})
afterAll(() => {
  if (previousLogEnv === undefined) delete process.env.SLEEPER_LOG
  else process.env.SLEEPER_LOG = previousLogEnv
})

beforeEach(() => {
  mockLoadThresholds.mockReset().mockReturnValue(THRESHOLDS)
  mockLoadTimeline.mockReset().mockReturnValue({
    packageId: 'timeline-package',
    actors: {},
    provenance: {},
    events: [],
  })
  mockRunReplay.mockReset().mockResolvedValue(okSummary())
  mockClosePool.mockReset().mockResolvedValue(undefined)
  mockAssertPlaybookModel.mockReset().mockResolvedValue(undefined)
})

describe('parseEvent — malformed payload rejection', () => {
  it.each(['actor_id', 'kind', 'content', 'occurred_at'] as const)(
    'rejects a payload missing %s with 400 missing_fields, never reaching runReplay',
    async (field) => {
      const payload = validPayload()
      delete payload[field]
      const res = await ingestHandler(payload)
      expect(res.statusCode).toBe(400)
      expect(parseBody(res)).toMatchObject({ error: 'missing_fields' })
      expect(mockRunReplay).not.toHaveBeenCalled()
    },
  )

  it('rejects a non-string occurred_at as an unparseable timestamp (wrong type, not just absent)', async () => {
    // Date.parse coerces its argument with ToString rather than throwing on a non-string, so a
    // payload whose occurred_at decoded as a number (JSON has no notion of our TS types) sails
    // past the `!raw.occurred_at` truthiness check — 20240101 is truthy — and must be caught by
    // the Date.parse/isNaN check instead. Confirmed at the node level: Date.parse(20240101) is NaN.
    const res = await ingestHandler(validPayload({ occurred_at: 20240101 as unknown as string }))
    expect(res.statusCode).toBe(400)
    expect(parseBody(res)).toMatchObject({ error: 'invalid_timestamp' })
    expect(mockRunReplay).not.toHaveBeenCalled()
  })

  it('rejects an unparseable occurred_at string', async () => {
    const res = await ingestHandler(validPayload({ occurred_at: 'not-a-real-date' }))
    expect(res.statusCode).toBe(400)
    expect(parseBody(res)).toMatchObject({ error: 'invalid_timestamp' })
  })

  it('rejects a body that is not valid JSON', async () => {
    const res = await ingestHandler({ body: '{not json' })
    expect(res.statusCode).toBe(400)
    expect(parseBody(res)).toMatchObject({ error: 'invalid_json' })
    expect(mockRunReplay).not.toHaveBeenCalled()
  })

  it('rejects over-length content rather than truncating it', async () => {
    // The stored row is the evidence a later hold is justified by (see the MAX_CONTENT_CHARS
    // comment in handler.ts) — a truncated row would silently not be what the caller sent. What is
    // worth pinning here is specifically REJECTION: nothing partial reaches runReplay/the cluster.
    const overLong = 'x'.repeat(MAX_CONTENT_CHARS + 1)
    const res = await ingestHandler(validPayload({ content: overLong }))
    expect(res.statusCode).toBe(400)
    const body = parseBody(res)
    expect(body.error).toBe('field_too_long')
    expect(body.message).toContain('content')
    expect(mockRunReplay).not.toHaveBeenCalled()
  })

  it('accepts content at exactly the cap — the limit is inclusive, not off-by-one', async () => {
    const atCap = 'x'.repeat(MAX_CONTENT_CHARS)
    const res = await ingestHandler(validPayload({ content: atCap }))
    expect(res.statusCode).toBe(200)
  })

  it('rejects an over-length package_id the same way as content', async () => {
    const res = await ingestHandler(validPayload({ package_id: 'p'.repeat(300) }))
    expect(res.statusCode).toBe(400)
    const body = parseBody(res)
    expect(body.error).toBe('field_too_long')
    expect(body.message).toContain('package_id')
  })

  it('rejects an over-length source_url when one is supplied', async () => {
    const res = await ingestHandler(
      validPayload({ source_url: 'https://example.com/' + 'a'.repeat(3000) }),
    )
    expect(res.statusCode).toBe(400)
    expect(parseBody(res).message).toContain('source_url')
  })

  it('treats a missing source_url as optional — parsed as null, not rejected', async () => {
    const res = await ingestHandler(validPayload())
    expect(res.statusCode).toBe(200)
    expect(mockRunReplay).toHaveBeenCalledWith(
      expect.objectContaining({ events: [expect.objectContaining({ sourceUrl: null })] }),
      expect.anything(),
    )
  })

  it('parses fields delivered at the top level, not only inside a JSON-string `body`', async () => {
    // API Gateway wraps the payload in `body`; a direct Lambda invoke (or this call) delivers the
    // fields at the top level. tests/server.test.ts only ever exercises the `body`-wrapped shape.
    const res = await ingestHandler(validPayload())
    expect(res.statusCode).toBe(200)
  })
})

describe('failure taxonomy — 400 vs 500, and no message leak', () => {
  it('maps a BadRequestError thrown anywhere in the pipeline to 400, not only from parseEvent', async () => {
    // The catch block's `instanceof BadRequestError` check does not care where the error came
    // from. Throwing one out of the mocked runReplay — which in real life never throws
    // BadRequestError — isolates that branch from parseEvent's own callers of it.
    mockRunReplay.mockRejectedValue(new BadRequestError('custom_code', 'a caller-fixable problem'))
    const res = await ingestHandler(validPayload())
    expect(res.statusCode).toBe(400)
    expect(parseBody(res)).toMatchObject({ error: 'custom_code', message: 'a caller-fixable problem' })
  })

  it('maps an unexpected failure to a structured 500 with a reference, never the raw message', async () => {
    // Shaped like the pg error recordFailure's own comment names: hostname, IP, port, SQL user.
    // This no-leak property is asserted for the demo server elsewhere; it matters here too because
    // ingestHandler is the one entry point with no server-side proxy in front of it to redact for it.
    const sensitive =
      'connection to server at "sleeper-cluster-1234.gcp-europe-west1.cockroachlabs.cloud" ' +
      '(34.1.2.3), port 26257 failed: FATAL: password authentication failed for user "sleeper_agent"'
    mockRunReplay.mockRejectedValue(new Error(sensitive))
    const res = await ingestHandler(validPayload())
    expect(res.statusCode).toBe(500)
    const body = parseBody(res)
    expect(body.error).toBe('internal_error')
    expect(body.ref).toMatch(/^[0-9a-f]{8}$/)
    expect(res.body).not.toContain('sleeper_agent')
    expect(res.body).not.toContain('34.1.2.3')
    expect(res.body).not.toContain(sensitive)
  })

  it('treats an ensurePlaybookModel failure as an internal error, not a caller error', async () => {
    // Uses a fresh module graph rather than the shared static import above: by this point in the
    // file `checked` in the statically-imported handler has already memoised a RESOLVED promise
    // (from an earlier passing test), and `checked ??= …` means no rejection set on the mock here
    // would ever be seen through it. A cold module graph is what actually lets this mock bite.
    vi.resetModules()
    const memory = await import('../src/memory.js')
    const corpus = await import('../src/corpus.js')
    const db = await import('../src/db.js')
    vi.mocked(memory.assertPlaybookModel).mockRejectedValue(
      new Error('GROUP BY query against a dead cluster'),
    )
    vi.mocked(corpus.loadThresholds).mockReturnValue(THRESHOLDS)
    vi.mocked(db.closePool).mockResolvedValue(undefined)

    const { ingestHandler: freshIngest } = await import('../src/handler.js')
    const res = await freshIngest(validPayload())
    expect(res.statusCode).toBe(500)
    expect(parseBody(res)).toMatchObject({ error: 'internal_error' })
    expect(res.body).not.toContain('dead cluster')
  })

  it('a corrupt thresholds file produces the structured error, not a bare unhandled rejection', async () => {
    // loadThresholds is called INSIDE the try in both handlers specifically so a truncated/corrupt
    // data/thresholds.json still leaves through the same structured response instead of API
    // Gateway synthesising a bare 502 with no body. Asserting the promise RESOLVES (rather than
    // rejects) to a structured 500 is what actually pins that placement — moving the call outside
    // the try would make this same test reject instead, which is the regression this guards.
    mockLoadThresholds.mockImplementation(() => {
      throw new SyntaxError('Unexpected token } in JSON at position 412 in data/thresholds.json')
    })
    const res = await ingestHandler(validPayload())
    expect(res.statusCode).toBe(500)
    expect(parseBody(res)).toMatchObject({ error: 'internal_error' })
    expect(res.body).not.toContain('thresholds.json')
  })

  it('closes the pool even when the handler fails', async () => {
    mockRunReplay.mockRejectedValue(new Error('boom'))
    await ingestHandler(validPayload())
    expect(mockClosePool).toHaveBeenCalledTimes(1)
  })

  it('a closePool failure inside finally overrides even an otherwise-successful response', async () => {
    // Real language semantics, not a hypothetical: `await closePool()` lives in `finally`, and if
    // the finally block's own await rejects, that rejection REPLACES whatever the try block was
    // about to return — the carefully constructed structured body never reaches the caller. Pinned
    // so a refactor that treats finally as fire-and-forget cleanup notices it changed this.
    mockClosePool.mockRejectedValue(new Error('pool.end() timed out'))
    await expect(ingestHandler(validPayload())).rejects.toThrow('pool.end() timed out')
  })

  it('a closePool failure also overrides an already-caught error, not just a success', async () => {
    // The other half of the same override: the try block already failed and was caught (would
    // have produced a structured 500), but finally's own rejection wins over that too.
    mockRunReplay.mockRejectedValue(new Error('original failure'))
    mockClosePool.mockRejectedValue(new Error('pool.end() timed out'))
    await expect(ingestHandler(validPayload())).rejects.toThrow('pool.end() timed out')
  })
})

describe('package_id and actor derivation (ingestHandler)', () => {
  it('falls back to config.packageId when the payload omits package_id', async () => {
    const res = await ingestHandler(validPayload())
    expect(res.statusCode).toBe(200)
    expect(mockRunReplay).toHaveBeenCalledWith(
      expect.objectContaining({ packageId: config.packageId }),
      expect.anything(),
    )
  })

  it('prefers the payload package_id over the config default when both could apply', async () => {
    const res = await ingestHandler(validPayload({ package_id: 'payload-named-package' }))
    expect(res.statusCode).toBe(200)
    expect(mockRunReplay).toHaveBeenCalledWith(
      expect.objectContaining({ packageId: 'payload-named-package' }),
      expect.anything(),
    )
  })

  it('assesses the actor named in the EVENT, never the actor configured for the deployment', async () => {
    const res = await ingestHandler(validPayload({ actor_id: 'the-real-committer' }))
    expect(res.statusCode).toBe(200)
    expect(mockRunReplay).toHaveBeenCalledWith(
      expect.objectContaining({ suspectActor: 'the-real-committer' }),
      expect.anything(),
    )
    expect(mockRunReplay).not.toHaveBeenCalledWith(
      expect.objectContaining({ suspectActor: config.suspectActorOverride }),
      expect.anything(),
    )
  })

  it('returns 409 when the summary carries a holdId, 200 when it does not', async () => {
    mockRunReplay.mockResolvedValue(okSummary({ holdId: 'hold-abc-123' }))
    const res = await ingestHandler(validPayload())
    expect(res.statusCode).toBe(409)
    expect(parseBody(res).summary.holdId).toBe('hold-abc-123')
  })

  it('threads every step runReplay emits through into the response body, in order', async () => {
    // ingestHandler's emit callback (`(step) => { steps.push(step) }`) is otherwise never exercised
    // by a mocked runReplay that just resolves a value without calling the callback it was handed —
    // the accumulated `steps` array is what a caller uses to see progress, so it is worth pinning
    // that the callback actually wires runReplay's emissions into the returned body.
    const fakeStep: Step = {
      type: 'candidates',
      considered: 1,
      ranked: [],
      assessed: [],
      reason: 'only candidate with history in the window',
    }
    mockRunReplay.mockImplementation(async (_opts, emit) => {
      emit(fakeStep)
      emit(fakeStep)
      return okSummary()
    })
    const res = await ingestHandler(validPayload())
    expect(res.statusCode).toBe(200)
    expect(parseBody(res).steps).toEqual([fakeStep, fakeStep])
  })
})

describe('replayHandler', () => {
  it('a corrupt thresholds file produces a structured 500, mirroring ingestHandler', async () => {
    mockLoadThresholds.mockImplementation(() => {
      throw new Error('thresholds.json is not valid JSON')
    })
    const res = await replayHandler()
    expect(res.statusCode).toBe(500)
    expect(parseBody(res)).toMatchObject({ error: 'internal_error' })
    expect(res.body).not.toContain('thresholds.json')
  })

  it('never leaks a raw failure message into the response body', async () => {
    mockRunReplay.mockRejectedValue(new Error('FATAL: password authentication failed for user "x"'))
    const res = await replayHandler()
    expect(res.statusCode).toBe(500)
    expect(res.body).not.toContain('password authentication failed')
  })

  it('assesses config.suspectActorOverride, not an event-derived actor — replay names no one webhook payload', async () => {
    // The mirror image of the ingestHandler actor-derivation test above: replayHandler has no
    // inbound event to take an actor from, so it is the ONE path that legitimately reads
    // config.suspectActorOverride, driven by config.packageId/loadTimeline rather than a webhook body.
    const res = await replayHandler()
    expect(res.statusCode).toBe(200)
    expect(mockRunReplay).toHaveBeenCalledWith(
      expect.objectContaining({
        suspectActor: config.suspectActorOverride,
        packageId: 'timeline-package',
      }),
      expect.anything(),
    )
  })

  it('closes the pool even on success', async () => {
    await replayHandler()
    expect(mockClosePool).toHaveBeenCalledTimes(1)
  })

  it('a closePool failure inside finally overrides even an otherwise-successful response', async () => {
    // Same finally-overrides-return semantics as the ingestHandler test above, pinned separately
    // because replayHandler has its own independent try/finally, not shared code.
    mockClosePool.mockRejectedValue(new Error('pool.end() timed out'))
    await expect(replayHandler()).rejects.toThrow('pool.end() timed out')
  })
})

describe('assertPlaybookModel memoisation across a warm container', () => {
  // Fresh module graph per test: `checked` in handler.ts is module-scoped, so reusing the
  // statically-imported handler above (as the rest of this file does) would let one test's memo
  // state leak into the next. vi.resetModules() plus a dynamic re-import gives each test its own
  // `checked = null`, mirroring a genuinely cold Lambda execution context.
  beforeEach(() => {
    vi.resetModules()
  })

  it('checks the corpus/model once and reuses it — not re-run on every later invocation', async () => {
    const memory = await import('../src/memory.js')
    const corpus = await import('../src/corpus.js')
    const agent = await import('../src/agent.js')
    const db = await import('../src/db.js')
    vi.mocked(memory.assertPlaybookModel).mockResolvedValue(undefined)
    vi.mocked(corpus.loadThresholds).mockReturnValue(THRESHOLDS)
    vi.mocked(agent.runReplay).mockResolvedValue(okSummary())
    vi.mocked(db.closePool).mockResolvedValue(undefined)

    const { ingestHandler: freshIngest } = await import('../src/handler.js')
    await freshIngest(validPayload())
    await freshIngest(validPayload())
    await freshIngest(validPayload())

    expect(memory.assertPlaybookModel).toHaveBeenCalledTimes(1)
  })

  it('clears the memo on failure, so one transient fault does not wedge every later invocation', async () => {
    const memory = await import('../src/memory.js')
    const corpus = await import('../src/corpus.js')
    const agent = await import('../src/agent.js')
    const db = await import('../src/db.js')
    vi.mocked(memory.assertPlaybookModel)
      .mockRejectedValueOnce(new Error('transient cluster blip'))
      .mockResolvedValue(undefined)
    vi.mocked(corpus.loadThresholds).mockReturnValue(THRESHOLDS)
    vi.mocked(agent.runReplay).mockResolvedValue(okSummary())
    vi.mocked(db.closePool).mockResolvedValue(undefined)

    const { ingestHandler: freshIngest } = await import('../src/handler.js')

    const first = await freshIngest(validPayload())
    expect(first.statusCode).toBe(500) // the transient fault surfaces on the invocation that hit it

    const second = await freshIngest(validPayload())
    expect(second.statusCode).toBe(200) // and does not wedge the next one on the same container

    // Called twice, not once: if the rejected check had been cached like a success, the second
    // call would have reused that same rejected promise forever and stayed at 500.
    expect(memory.assertPlaybookModel).toHaveBeenCalledTimes(2)
  })
})
