/**
 * AWS Lambda entry point — the same agent loop, triggered by a webhook instead of a button.
 *
 * In the demo the events are replayed from the bundled corpus; in the deployed shape this is what
 * a GitHub webhook (or a distro's release pipeline) posts to. Both paths call `runReplay`/the
 * memory layer in src/agent.ts, so there is one decision implementation, not a demo one and a
 * real one.
 *
 * Two entry points:
 *   - `ingestHandler`  — one event arrives; embed it, write it, and assess if it is a release.
 *   - `replayHandler`  — replay the bundled corpus (used to warm a fresh cluster).
 *
 * Deployment notes are in DEMO.md. The function needs `bedrock:InvokeModel`, `bedrock:Converse`
 * and outbound access to the cluster; DATABASE_URL comes from Secrets Manager or an encrypted
 * environment variable, never from the repo.
 */
import { config } from './config.js'
import { loadThresholds, loadTimeline } from './corpus.js'
import { runReplay, type Step, type TimelineEvent } from './agent.js'
import { closePool } from './db.js'
import { newCorrId, recordFailure } from './log.js'

type LambdaResponse = { statusCode: number; headers: Record<string, string>; body: string }

function respond(statusCode: number, body: unknown): LambdaResponse {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

export type WebhookEvent = {
  body?: string
  /**
   * Which package's memory this event belongs to.
   *
   * Optional, falling back to `config.packageId`. It has to be per-event rather than per-deployment:
   * a distro's release pipeline posts events for every package it builds, and a function that can
   * only ever write to one package would need one Lambda per package — with one connection pool
   * each — to watch a repository of thousands.
   */
  package_id?: string
  actor_id?: string
  kind?: string
  content?: string
  occurred_at?: string
  source_url?: string
}

/**
 * Rejected rather than truncated when over the cap.
 *
 * `content` is attacker-controlled (it is a commit message or a mailing-list post), it is forwarded
 * verbatim to Bedrock, and it is stored as the evidence a hold is later justified by. Truncating it
 * silently would mean the row in `events` is not what the caller sent, which breaks the audit trail
 * in the one place it has to hold. So: an explicit 400 naming the limit.
 *
 * 8 KiB is roughly ten times the longest event in the bundled xz corpus and well inside Titan's
 * input limit, so nothing legitimate is near it.
 */
export const MAX_CONTENT_CHARS = Number(process.env.MAX_EVENT_CONTENT_CHARS ?? 8_192)
const MAX_ID_CHARS = 256
const MAX_URL_CHARS = 2_048

/** Thrown for anything the caller could fix by sending a different payload — never for our faults. */
export class BadRequestError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'BadRequestError'
    this.code = code
  }
}

function bounded(value: string, max: number, field: string): string {
  if (value.length > max) {
    throw new BadRequestError(
      'field_too_long',
      `${field} is ${value.length} characters, over the ${max}-character limit.`,
    )
  }
  return value
}

function parseEvent(event: WebhookEvent): TimelineEvent {
  // API Gateway delivers the payload as a JSON string in `body`; a direct invoke delivers the
  // fields at the top level. Accept both rather than making the caller care.
  let raw: WebhookEvent
  try {
    raw = event.body ? (JSON.parse(event.body) as WebhookEvent) : event
  } catch {
    throw new BadRequestError('invalid_json', 'Request body is not valid JSON.')
  }
  if (!raw.actor_id || !raw.kind || !raw.content || !raw.occurred_at) {
    throw new BadRequestError(
      'missing_fields',
      'Event requires actor_id, kind, content and occurred_at.',
    )
  }
  if (Number.isNaN(Date.parse(raw.occurred_at))) {
    throw new BadRequestError('invalid_timestamp', 'occurred_at is not a parseable timestamp.')
  }
  return {
    packageId: bounded(raw.package_id ?? config.packageId, MAX_ID_CHARS, 'package_id'),
    actorId: bounded(raw.actor_id, MAX_ID_CHARS, 'actor_id'),
    kind: bounded(raw.kind, MAX_ID_CHARS, 'kind'),
    content: bounded(raw.content, MAX_CONTENT_CHARS, 'content'),
    occurredAt: raw.occurred_at,
    sourceUrl: raw.source_url ? bounded(raw.source_url, MAX_URL_CHARS, 'source_url') : null,
  }
}

/** One webhook-shaped event into memory, assessed against everything already there. */
export async function ingestHandler(event: WebhookEvent): Promise<LambdaResponse> {
  const corrId = newCorrId()
  const steps: Step[] = []

  try {
    // Inside the try, not before it. `loadThresholds` reads and parses data/thresholds.json, so a
    // truncated or half-written file threw straight out of the handler — past this catch — and the
    // caller got whatever API Gateway makes of an unhandled Lambda exception (a bare 502 with no
    // body). Every failure this function can have now leaves through the same structured response.
    const { thresholds } = loadThresholds()
    const parsed = parseEvent(event)

    const summary = await runReplay(
      {
        // The event's own package, not the deployment's default: `parseEvent` already resolved the
        // fallback, and taking it from anywhere else here would silently assess event A's arc
        // against package B's memory.
        packageId: parsed.packageId,
        // Consequence of making the package per-event: the assessed actor has to be per-event too.
        // For a single inbound event the actor who produced it is the actor to assess, and pinning
        // it here is not the thing `assess()` was fixed to stop doing — it is a fact of the
        // payload, not a name someone configured. It also keeps the webhook to one arc per event:
        // candidate ranking over the whole package would spend N model calls on every commit that
        // arrives, and a webhook fires thousands of times a day.
        suspectActor: parsed.actorId,
        windowDays: config.arcWindowDays,
        thresholds,
        events: [parsed],
        // Never reset: this event joins the memory already in the cluster, which is the entire
        // reason a single innocuous-looking event can still trip the gate.
        reset: false,
        corrId,
      },
      (step) => {
        steps.push(step)
      },
    )
    return respond(summary.holdId ? 409 : 200, { summary, steps, corrId })
  } catch (err) {
    // The caller learns the shape of the problem and a reference; the detail — which for a pg
    // failure names the cluster host and the SQL user — stays in the log. See `recordFailure`.
    if (err instanceof BadRequestError) {
      return respond(400, { error: err.code, message: err.message, corrId })
    }
    const ref = recordFailure('ingest.failed', err, { corrId })
    return respond(500, { error: 'internal_error', ref, corrId })
  } finally {
    // Lambda freezes the execution context between invocations; a pooled socket left open across
    // a freeze comes back dead, so the pool is closed on the way out.
    await closePool()
  }
}

/** Replays the bundled corpus into a fresh cluster. */
export async function replayHandler(): Promise<LambdaResponse> {
  const corrId = newCorrId()
  try {
    const { thresholds } = loadThresholds()
    const timeline = loadTimeline(config.packageId)
    const summary = await runReplay(
      {
        packageId: timeline.packageId,
        // Nothing named: the corpus replay picks its own candidates out of memory.
        suspectActor: config.suspectActorOverride,
        maxCandidates: config.maxCandidates,
        windowDays: config.arcWindowDays,
        thresholds,
        events: timeline.events,
        corrId,
      },
      () => {},
    )
    return respond(200, { ...summary, corrId })
  } catch (err) {
    const ref = recordFailure('replay.failed', err, { corrId })
    return respond(500, { error: 'internal_error', ref, corrId })
  } finally {
    await closePool()
  }
}
