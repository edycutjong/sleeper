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
  actor_id?: string
  kind?: string
  content?: string
  occurred_at?: string
  source_url?: string
}

function parseEvent(event: WebhookEvent): TimelineEvent {
  // API Gateway delivers the payload as a JSON string in `body`; a direct invoke delivers the
  // fields at the top level. Accept both rather than making the caller care.
  const raw = event.body ? (JSON.parse(event.body) as WebhookEvent) : event
  if (!raw.actor_id || !raw.kind || !raw.content || !raw.occurred_at) {
    throw new Error('Event requires actor_id, kind, content and occurred_at.')
  }
  return {
    packageId: config.packageId,
    actorId: raw.actor_id,
    kind: raw.kind,
    content: raw.content,
    occurredAt: raw.occurred_at,
    sourceUrl: raw.source_url ?? null,
  }
}

/** One webhook-shaped event into memory, assessed against everything already there. */
export async function ingestHandler(event: WebhookEvent): Promise<LambdaResponse> {
  const { thresholds } = loadThresholds()
  const steps: Step[] = []

  try {
    const summary = await runReplay(
      {
        packageId: config.packageId,
        suspectActor: config.suspectActor,
        windowDays: config.arcWindowDays,
        thresholds,
        events: [parseEvent(event)],
        // Never reset: this event joins the memory already in the cluster, which is the entire
        // reason a single innocuous-looking event can still trip the gate.
        reset: false,
      },
      (step) => {
        steps.push(step)
      },
    )
    return respond(summary.holdId ? 409 : 200, { summary, steps })
  } catch (err) {
    return respond(400, { error: err instanceof Error ? err.message : String(err) })
  } finally {
    // Lambda freezes the execution context between invocations; a pooled socket left open across
    // a freeze comes back dead, so the pool is closed on the way out.
    await closePool()
  }
}

/** Replays the bundled corpus into a fresh cluster. */
export async function replayHandler(): Promise<LambdaResponse> {
  const { thresholds } = loadThresholds()
  const timeline = loadTimeline(config.packageId)
  try {
    const summary = await runReplay(
      {
        packageId: timeline.packageId,
        suspectActor: config.suspectActor,
        windowDays: config.arcWindowDays,
        thresholds,
        events: timeline.events,
      },
      () => {},
    )
    return respond(200, summary)
  } finally {
    await closePool()
  }
}
