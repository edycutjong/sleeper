import {
  BedrockRuntimeClient,
  ConverseCommand,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime'
import { config } from './config.js'
import { emit } from './log.js'

/**
 * A replay of the xz timeline is ~40 sequential Bedrock calls (one embedding per event, plus the
 * arc summary and the two rationale calls). On a fresh account that is comfortably inside the
 * default on-demand quota, but a burst still earns a `ThrottlingException`, and the SDK default —
 * three attempts with no explicit socket timeout — leaves two failure modes that both look like
 * "the demo hung": a throttle that exhausts its attempts halfway through the timeline, and a
 * connection that never gets a FIN and sits until the process is killed.
 *
 * Timeouts are explicit rather than left to the platform default, and are deliberately generous:
 * a Converse call producing a 600-token rationale genuinely takes tens of seconds.
 */
const CONNECTION_TIMEOUT_MS = Number(process.env.BEDROCK_CONNECT_TIMEOUT_MS ?? 5_000)
const REQUEST_TIMEOUT_MS = Number(process.env.BEDROCK_REQUEST_TIMEOUT_MS ?? 60_000)
const MAX_ATTEMPTS = Number(process.env.BEDROCK_MAX_ATTEMPTS ?? 5)

const client = new BedrockRuntimeClient({
  region: config.aws.region,
  // The SDK's own adaptive retry mode covers the transport-level retries; `withRetry` below sits
  // one layer up and covers the case where the SDK gives up.
  maxAttempts: MAX_ATTEMPTS,
  retryMode: 'adaptive',
  requestHandler: {
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    requestTimeout: REQUEST_TIMEOUT_MS,
  },
})

/**
 * Error names Bedrock uses for "come back later", as opposed to "this request is wrong".
 *
 * Only transient conditions belong here. A `ValidationException` or `AccessDeniedException`
 * retried five times is five times the wait before the operator sees the real problem.
 */
export const RETRYABLE_ERROR_NAMES = new Set([
  'ThrottlingException',
  'TooManyRequestsException',
  'ServiceUnavailable',
  'ServiceUnavailableException',
  'ServiceQuotaExceededException',
  'ModelTimeoutException',
  'InternalServerException',
  'TimeoutError',
])

export function isRetryable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
  if (e.name && RETRYABLE_ERROR_NAMES.has(e.name)) return true
  // 429 and 5xx from a service that did not name itself — treat the status as authoritative.
  const status = e.$metadata?.httpStatusCode
  return status === 429 || (typeof status === 'number' && status >= 500 && status < 600)
}

export type RetryOptions = {
  /** Total attempts including the first. */
  attempts?: number
  /** First backoff, doubled each attempt. */
  baseDelayMs?: number
  /** Ceiling on a single backoff, so attempt 6 does not sleep for half a minute. */
  maxDelayMs?: number
  /** Injected by the test suite; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>
  /** Named in the log line so a retry storm can be attributed to a stage. */
  label?: string
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Retries `fn` on transient Bedrock errors with exponential backoff and full jitter.
 *
 * Full jitter (a uniform draw from `[0, delay]`) rather than a fixed doubling because the replay
 * issues its calls in a tight loop: on a throttle, lock-step retries from every in-flight call
 * would simply re-collide. Jitter spreads them.
 *
 * HONEST LIMIT: this makes a single call durable, it does not make the replay transactional. If
 * every attempt fails mid-timeline the replay still aborts with a partially-ingested memory. That
 * is survivable here only because a replay is idempotent by construction — `runReplay` resets the
 * package before it starts, so re-running it produces the same end state rather than a double
 * timeline. A production ingest path that could not reset would need a compensating delete keyed
 * on the correlation id, and this code does not have one.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? MAX_ATTEMPTS
  const baseDelayMs = options.baseDelayMs ?? 250
  const maxDelayMs = options.maxDelayMs ?? 8_000
  const sleep = options.sleep ?? defaultSleep

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (!isRetryable(err) || attempt === attempts) throw err
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
      const delayMs = Math.round(Math.random() * ceiling)
      emit('warn', 'bedrock.retry', {
        label: options.label,
        attempt,
        attempts,
        delayMs,
        errorName: (err as { name?: string }).name ?? 'unknown',
      })
      await sleep(delayMs)
    }
  }
  throw lastError
}

/**
 * Titan Text Embeddings V2 via Bedrock `InvokeModel`.
 * Every `events.content` and every `actor_arcs.arc_summary` goes through here before it is written,
 * so this is the single place embedding dimensionality is decided.
 */
export async function embed(text: string): Promise<number[]> {
  const response = await withRetry(
    () =>
      client.send(
        new InvokeModelCommand({
          modelId: config.aws.embeddingModelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify({
            inputText: text,
            dimensions: config.aws.embeddingDimensions,
            normalize: true,
          }),
        }),
      ),
    { label: 'embed' },
  )

  const payload = JSON.parse(new TextDecoder().decode(response.body)) as {
    embedding?: number[]
    message?: string
  }
  if (!payload.embedding) {
    throw new Error(`Bedrock returned no embedding: ${payload.message ?? JSON.stringify(payload)}`)
  }
  return payload.embedding
}

/**
 * Claude on Bedrock via the `Converse` API — used to roll a 90-day window of raw events into one
 * arc summary, and to compose the hold rationale and distro advisory.
 */
export async function converse(system: string, prompt: string, maxTokens = 1024): Promise<string> {
  const response = await withRetry(
    () =>
      client.send(
        new ConverseCommand({
          modelId: config.aws.chatModelId,
          system: [{ text: system }],
          messages: [{ role: 'user', content: [{ text: prompt }] }],
          inferenceConfig: { maxTokens },
        }),
      ),
    { label: 'converse' },
  )

  const text = response.output?.message?.content
    ?.map((block) => ('text' in block ? block.text : ''))
    .join('')
    .trim()

  if (!text) throw new Error('Bedrock Converse returned no text content')
  return text
}
