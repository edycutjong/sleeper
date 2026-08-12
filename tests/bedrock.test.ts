/**
 * Unit tests for the Bedrock wrapper: the retry/backoff policy, and the two model calls that sit
 * on top of it.
 *
 * No network call and no AWS credentials. `@aws-sdk/client-bedrock-runtime` is replaced wholesale
 * with a fake whose `send` is a controllable mock, so what is under test is bedrock.ts's OWN
 * logic — request shaping, response parsing, fail-fast vs. retry — never the SDK's transport or a
 * real model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'
import { setLogSink, type LogLine } from '../src/log.js'

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }))

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class FakeBedrockRuntimeClient {
    send = mockSend
  }
  // Real Command objects expose their constructor argument as `.input`; that is the only part of
  // the shape embed()/converse() rely on (via `client.send(new XCommand(...))`), so the fake need
  // not reproduce anything else about the real SDK classes.
  class FakeCommand {
    input: unknown
    constructor(input: unknown) {
      this.input = input
    }
  }
  return {
    BedrockRuntimeClient: FakeBedrockRuntimeClient,
    ConverseCommand: FakeCommand,
    InvokeModelCommand: FakeCommand,
  }
})

// `vi.mock` calls above are hoisted above this import by vitest's transform, so bedrock.ts's own
// `import { BedrockRuntimeClient, ... } from '@aws-sdk/client-bedrock-runtime'` resolves to the
// fakes — the module-level `client` it constructs is the fake client, and its `send` is `mockSend`.
import { embed, converse, withRetry, isRetryable } from '../src/bedrock.js'

const encodeBody = (payload: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(payload))

/** Shape of the AWS error bedrock.ts branches on: a `name`, sometimes an HTTP status. */
const awsError = (name: string, httpStatusCode?: number): Error =>
  Object.assign(new Error(name), {
    name,
    ...(httpStatusCode !== undefined ? { $metadata: { httpStatusCode } } : {}),
  })

const throttle = (): Error => awsError('ThrottlingException')

describe('isRetryable — the fail-fast/retry classification', () => {
  it('treats the documented transient error names as retryable', () => {
    expect(isRetryable(awsError('ThrottlingException'))).toBe(true)
    expect(isRetryable(awsError('ModelTimeoutException'))).toBe(true)
  })

  it('treats a validation/permission error as permanent, not retryable', () => {
    // This is the branch that matters most: getting it wrong turns a permanent failure (bad
    // request, no access) into a slow permanent failure that burns the whole retry budget first.
    expect(isRetryable(awsError('ValidationException'))).toBe(false)
    expect(isRetryable(awsError('AccessDeniedException', 403))).toBe(false)
  })

  it('falls back to the HTTP status when the service did not name itself', () => {
    expect(isRetryable({ $metadata: { httpStatusCode: 429 } })).toBe(true)
    expect(isRetryable({ $metadata: { httpStatusCode: 500 } })).toBe(true)
    expect(isRetryable({ $metadata: { httpStatusCode: 599 } })).toBe(true)
    // Boundaries: one below 500 and one above the 5xx band must not be swept in.
    expect(isRetryable({ $metadata: { httpStatusCode: 499 } })).toBe(false)
    expect(isRetryable({ $metadata: { httpStatusCode: 600 } })).toBe(false)
    expect(isRetryable({ $metadata: { httpStatusCode: 400 } })).toBe(false)
  })

  it('is false for anything that is not an error-shaped object', () => {
    expect(isRetryable(null)).toBe(false)
    expect(isRetryable(undefined)).toBe(false)
    expect(isRetryable('boom')).toBe(false)
    expect(isRetryable(42)).toBe(false)
    expect(isRetryable({})).toBe(false)
  })
})

describe('withRetry — backoff, exhaustion and fail-fast', () => {
  // Every retry logs a warn line; keep the suite output readable.
  let restoreSink: (line: LogLine) => void
  beforeEach(() => {
    restoreSink = setLogSink(() => {})
  })
  afterEach(() => {
    setLogSink(restoreSink)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('retries a retryable failure and returns the eventual success, with the attempt count you expect', async () => {
    const fn = vi.fn().mockRejectedValueOnce(throttle()).mockRejectedValueOnce(throttle()).mockResolvedValue('ok')
    const result = await withRetry(fn, { attempts: 5, sleep: async () => {} })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('exhausts its budget and throws the LAST error, not a wrapper that loses it', async () => {
    // Three distinct, distinguishable failures. If the code re-threw the FIRST error, or wrapped
    // it in something generic, this would still pass a sloppier assertion — asserting the exact
    // message of the third one is what actually pins "last error, uncorrupted".
    const err1 = awsError('ThrottlingException')
    err1.message = 'attempt 1 failed'
    const err2 = awsError('ThrottlingException')
    err2.message = 'attempt 2 failed'
    const err3 = awsError('ThrottlingException')
    err3.message = 'attempt 3 failed — the real one'
    const fn = vi.fn().mockRejectedValueOnce(err1).mockRejectedValueOnce(err2).mockRejectedValueOnce(err3)

    await expect(withRetry(fn, { attempts: 3, sleep: async () => {} })).rejects.toThrow(
      'attempt 3 failed — the real one',
    )
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('fails fast on a non-retryable error — a validation error must not consume the retry budget', async () => {
    const fn = vi.fn().mockRejectedValue(awsError('ValidationException'))
    const sleep = vi.fn(async () => {})

    await expect(withRetry(fn, { attempts: 5, sleep })).rejects.toThrow('ValidationException')
    expect(fn).toHaveBeenCalledTimes(1)
    // The budget being unspent is the whole point: no backoff was ever entered.
    expect(sleep).not.toHaveBeenCalled()
  })

  it('really waits out the backoff before retrying — the promise does not resolve early', async () => {
    vi.useFakeTimers()
    // Full jitter draws from [0, ceiling]; pin Math.random so the draw is deterministic (== ceiling)
    // without touching the jitter formula itself, so this test can assert on wall-clock timing.
    vi.spyOn(Math, 'random').mockReturnValue(1)

    const fn = vi.fn().mockRejectedValueOnce(throttle()).mockResolvedValue('ok')
    const pending = withRetry(fn, { attempts: 3, baseDelayMs: 5_000 })

    await vi.advanceTimersByTimeAsync(0) // let the first (failing) attempt run and arm the timer
    expect(fn).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(4_999)
    expect(fn).toHaveBeenCalledTimes(1) // backoff for attempt 1 is exactly baseDelayMs — not yet due

    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('grows the backoff ceiling each attempt, and the actual (jittered) delay always lands inside it', async () => {
    const delays: number[] = []
    const fn = vi.fn().mockRejectedValue(throttle())
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms)
    })

    await expect(
      withRetry(fn, { attempts: 5, baseDelayMs: 100, maxDelayMs: 100_000, sleep }),
    ).rejects.toThrow('ThrottlingException')

    // One sleep per retried attempt; the final (5th) attempt throws instead of backing off again.
    expect(delays).toHaveLength(4)
    // Real Math.random() — asserted as a range, per attempt's ceiling, never an exact value.
    const ceilings = [100, 200, 400, 800]
    for (const [i, ceiling] of ceilings.entries()) {
      expect(delays[i]).toBeGreaterThanOrEqual(0)
      expect(delays[i]).toBeLessThanOrEqual(ceiling)
    }
    // "Grows" is a property of the ceiling, not of any single jittered draw (which could by chance
    // be smaller on a later attempt) — this is exactly why the assertion above is a range.
    expect(ceilings[1]).toBeGreaterThan(ceilings[0]!)
    expect(ceilings[2]).toBeGreaterThan(ceilings[1]!)
    expect(ceilings[3]).toBeGreaterThan(ceilings[2]!)
  })

  it('never backs off past maxDelayMs, however many attempts the exponent would otherwise imply', async () => {
    const delays: number[] = []
    const fn = vi.fn().mockRejectedValue(throttle())
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms)
    })

    await expect(
      withRetry(fn, { attempts: 6, baseDelayMs: 1_000, maxDelayMs: 1_500, sleep }),
    ).rejects.toThrow()

    expect(delays).toHaveLength(5)
    for (const d of delays) expect(d).toBeLessThanOrEqual(1_500)
    // Attempts 3-5 would ask for 4000/8000/16000ms uncapped — proof the ceiling, not just the draw,
    // was clamped.
    expect(delays[2]).toBeLessThanOrEqual(1_500)
    expect(delays[3]).toBeLessThanOrEqual(1_500)
    expect(delays[4]).toBeLessThanOrEqual(1_500)
  })

  // The exhaustion path above always throws from INSIDE the loop, on the `attempt === attempts`
  // check — the `throw lastError` after the loop is reachable only when the loop body never runs
  // at all, i.e. a caller passes `attempts <= 0`. That is a degenerate config, not a real budget
  // exhaustion, and it is worth pinning precisely because the result is surprising: `fn` is never
  // even tried, and the promise rejects with `undefined` (lastError's un-set initial value) rather
  // than a real Error. This is current behaviour, not a recommendation.
  it('with attempts <= 0, never calls fn and rejects with undefined instead of exhausting a budget', async () => {
    const fn = vi.fn()
    await expect(withRetry(fn, { attempts: 0, sleep: async () => {} })).rejects.toBeUndefined()
    expect(fn).not.toHaveBeenCalled()
  })

  it('logs "unknown" rather than crashing when a retryable failure has no error name', async () => {
    // isRetryable() accepts a nameless error as long as its HTTP status is a 429/5xx (see the
    // status-only branch), which means the retry log's `errorName` field cannot assume `.name`
    // exists. Pin the fallback, not just the happy path where AWS always names its exceptions.
    const lines: LogLine[] = []
    const restore = setLogSink((line) => lines.push(line))
    try {
      const fn = vi.fn().mockRejectedValueOnce({ $metadata: { httpStatusCode: 503 } }).mockResolvedValue('ok')
      await withRetry(fn, { attempts: 2, sleep: async () => {}, label: 'embed' })
    } finally {
      setLogSink(restore)
    }
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ event: 'bedrock.retry', errorName: 'unknown' })
  })
})

describe('embed — Titan Text Embeddings V2 via InvokeModel', () => {
  let restoreSink: (line: LogLine) => void
  beforeEach(() => {
    mockSend.mockReset()
    restoreSink = setLogSink(() => {})
  })
  afterEach(() => {
    setLogSink(restoreSink)
    vi.useRealTimers()
  })

  it('sends the documented request shape and returns the parsed embedding', async () => {
    const vector = [0.1, -0.2, 0.3]
    mockSend.mockResolvedValueOnce({ body: encodeBody({ embedding: vector }) })

    const result = await embed('the maintainer handed over release signing authority')

    expect(result).toEqual(vector)
    expect(mockSend).toHaveBeenCalledTimes(1)
    const input = (mockSend.mock.calls[0]![0] as { input: unknown }).input
    expect(input).toEqual({
      modelId: config.aws.embeddingModelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        inputText: 'the maintainer handed over release signing authority',
        dimensions: config.aws.embeddingDimensions,
        normalize: true,
      }),
    })
  })

  it('rejects a response with no embedding, naming the service message rather than swallowing it', async () => {
    mockSend.mockResolvedValueOnce({ body: encodeBody({ message: 'model access not granted' }) })
    await expect(embed('x')).rejects.toThrow(/model access not granted/)
  })

  it('rejects a response with no embedding and no message by surfacing the raw payload', async () => {
    mockSend.mockResolvedValueOnce({ body: encodeBody({ unexpected: 'shape' }) })
    await expect(embed('x')).rejects.toThrow(/"unexpected":"shape"/)
  })

  it('is durable to one throttle before succeeding — retried under the "embed" label', async () => {
    vi.useFakeTimers()
    mockSend.mockRejectedValueOnce(throttle()).mockResolvedValueOnce({ body: encodeBody({ embedding: [1] }) })

    const pending = embed('retried text')
    await vi.advanceTimersByTimeAsync(10_000) // well past the largest possible attempt-1 backoff
    await expect(pending).resolves.toEqual([1])
    expect(mockSend).toHaveBeenCalledTimes(2)
  })
})

describe('converse — Claude via the Converse API', () => {
  let restoreSink: (line: LogLine) => void
  beforeEach(() => {
    mockSend.mockReset()
    restoreSink = setLogSink(() => {})
  })
  afterEach(() => {
    setLogSink(restoreSink)
    vi.useRealTimers()
  })

  it('sends the documented request shape and joins the returned text blocks', async () => {
    mockSend.mockResolvedValueOnce({
      output: { message: { content: [{ text: 'Behavioural arc: ' }, { text: 'slow trust acquisition.' }] } },
    })

    const result = await converse('You are a release-gate analyst.', 'Summarise this actor.', 2048)

    expect(result).toBe('Behavioural arc: slow trust acquisition.')
    const input = (mockSend.mock.calls[0]![0] as { input: unknown }).input
    expect(input).toEqual({
      modelId: config.aws.chatModelId,
      system: [{ text: 'You are a release-gate analyst.' }],
      messages: [{ role: 'user', content: [{ text: 'Summarise this actor.' }] }],
      inferenceConfig: { maxTokens: 2048 },
    })
  })

  it('defaults maxTokens to 1024 when the caller does not name one', async () => {
    mockSend.mockResolvedValueOnce({ output: { message: { content: [{ text: 'ok' }] } } })
    await converse('system', 'prompt')
    const input = (mockSend.mock.calls[0]![0] as { input: { inferenceConfig: { maxTokens: number } } }).input
    expect(input.inferenceConfig.maxTokens).toBe(1024)
  })

  it('skips content blocks that carry no text rather than erroring on them', async () => {
    mockSend.mockResolvedValueOnce({
      output: { message: { content: [{ text: 'kept — ' }, { toolUse: { name: 'irrelevant' } }] } },
    })
    await expect(converse('s', 'p')).resolves.toBe('kept —')
  })

  it('rejects an empty content array instead of returning blank text', async () => {
    mockSend.mockResolvedValueOnce({ output: { message: { content: [] } } })
    await expect(converse('s', 'p')).rejects.toThrow(/no text content/)
  })

  it('rejects when the response carries no output at all', async () => {
    mockSend.mockResolvedValueOnce({})
    await expect(converse('s', 'p')).rejects.toThrow(/no text content/)
  })

  it('is durable to one throttle before succeeding — retried under the "converse" label', async () => {
    vi.useFakeTimers()
    mockSend
      .mockRejectedValueOnce(throttle())
      .mockResolvedValueOnce({ output: { message: { content: [{ text: 'rationale' }] } } })

    const pending = converse('s', 'p')
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(pending).resolves.toBe('rationale')
    expect(mockSend).toHaveBeenCalledTimes(2)
  })
})
