/**
 * AWS Lambda entry point, behind a Function URL.
 *
 * `ingestHandler` already returns `{statusCode, headers, body}` and already takes a payload shaped
 * like the webhook body, so this file is an adapter and nothing more — it maps a Function URL
 * request onto that call and refuses everything else. Deliberately no business logic here: the
 * decision path is `src/handler.ts`, and a second copy of it that only runs in production is how
 * the deployed behaviour and the tested behaviour drift apart.
 *
 * What it does own is the method/route policy, because the Function URL is public:
 *
 *   POST /            ingest one event and assess it against everything already in memory
 *   POST /ingest      the same, named
 *   GET  /health      liveness, no cluster round trip
 *
 * `replayHandler` is NOT exposed. It resets and re-ingests the whole corpus, so reaching it from
 * an unauthenticated public URL would let anyone wipe the memory the demo depends on — the same
 * reason `GET /api/replay` is unreachable on the local server and asserted so in the suite.
 */
import { ingestHandler, type WebhookEvent } from './handler.js'

type FunctionUrlEvent = {
  version?: string
  rawPath?: string
  body?: string
  isBase64Encoded?: boolean
  requestContext?: { http?: { method?: string; path?: string } }
}

type LambdaResponse = { statusCode: number; headers: Record<string, string>; body: string }

const JSON_HEADERS = { 'content-type': 'application/json' }

function respond(statusCode: number, body: unknown): LambdaResponse {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) }
}

export async function handler(event: FunctionUrlEvent): Promise<LambdaResponse> {
  const method = event.requestContext?.http?.method ?? 'GET'
  // Strip the stage/query and normalise a trailing slash so `/ingest/` and `/ingest` agree.
  const path = (event.requestContext?.http?.path ?? event.rawPath ?? '/').replace(/\/+$/, '') || '/'

  if (method === 'GET' && path === '/health') {
    return respond(200, { ok: true })
  }

  if (method !== 'POST' || (path !== '/' && path !== '/ingest')) {
    // Enumerating what IS allowed keeps a 404 from reading as "the deploy is broken".
    return respond(404, { error: 'not found', allowed: ['POST /', 'POST /ingest', 'GET /health'] })
  }

  // Function URLs base64-encode the body whenever the content type is not recognised as text.
  const raw = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : event.body

  let payload: WebhookEvent
  try {
    payload = raw ? (JSON.parse(raw) as WebhookEvent) : {}
  } catch {
    // Answer this here rather than letting it throw: `ingestHandler`'s own catch reports an
    // internal error, and malformed JSON from a caller is a 400, not our fault.
    return respond(400, { error: 'body is not valid JSON' })
  }

  return ingestHandler(payload)
}
