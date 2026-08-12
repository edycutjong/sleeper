/**
 * The demo server.
 *
 *   npm start        # http://127.0.0.1:3000
 *
 * Deliberately small: Node's own http module, no framework. It exposes the agent loop over
 * server-sent events so a judge can open one URL, press one button, and watch every write and
 * every vector search land in CockroachDB in real time. There is no login, no configuration
 * screen and no second scenario.
 *
 * The loop itself lives in src/agent.ts and is shared with `npm run replay` and the Lambda
 * handler — this file only transports it.
 *
 * Because there is no login, the server binds to loopback by default and the one destructive route
 * requires POST. See BIND_HOST and the `/api/replay` method check below — this is a demo surface,
 * not an authenticated API, and the boundary is the network, not a token.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'
import { loadThresholds, loadTimeline, type CalibratedThresholds } from './corpus.js'
import { FALLBACK_THRESHOLDS, type Thresholds } from './decide.js'
import { OFFLINE, providerBanner } from './embeddings.js'
import { runReplay, type Step } from './agent.js'
import {
  assertPlaybookModel,
  auditReader,
  explainScopedVia,
  holdEvidence,
  loadActorArc,
} from './memory.js'
import { assertUuid, resolveMcpMode, type SqlReader } from './mcp.js'
import { closePool, query } from './db.js'
import { createLogger, emit, newCorrId, recordFailure } from './log.js'

const here = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(here, '..', 'public')

/**
 * Reported by `/api/health` so an operator can tell which build answered.
 *
 * Read from package.json rather than hardcoded — a version constant that has to be edited by hand
 * is a version constant that is wrong. Unreadable is not fatal: health is more useful degraded
 * than absent.
 */
const VERSION = ((): string => {
  try {
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
      version?: string
    }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
})()

/**
 * Loopback by default.
 *
 * The previous `server.listen(port)` bound every interface, which on a laptop on conference wifi
 * puts an unauthenticated route that wipes the demo's memory on the local network. Overridable
 * because a container has to bind 0.0.0.0 to be reachable at all — but that is now a decision
 * someone makes, with an env var, rather than the default.
 */
const BIND_HOST = process.env.SLEEPER_BIND_HOST ?? '127.0.0.1'

/** One replay at a time: they all write to the same package's memory and would interleave. */
let replayInFlight = false

/**
 * The actor the last replay in this process actually assessed.
 *
 * `/api/explain` re-runs the prefix-scoped query using a stored arc's embedding, so it has to name
 * an actor — and now that the agent chooses the actor itself, the answer is whichever candidate
 * the last replay landed on, not a configured one. Null until a replay has run, which is exactly
 * the case the 404 below already covers.
 */
let lastAssessedActor: string | null = null

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  })
  res.end(payload)
}

/**
 * Resolves the audit read path and reports which one it is.
 *
 * The reader is closed immediately: this exists so `/api/state` and the UI header can say whether
 * the Managed MCP Server is the path in force, and holding a session open between requests would
 * make the answer stale rather than live. When MCP is not configured `resolveMcpMode` returns
 * before anything is dialled, so the default demo pays nothing for this.
 */
async function describeAuditPath(): Promise<{ via: 'mcp' | 'direct'; reason: string }> {
  const reader = await auditReader()
  try {
    noteAuditPath(reader)
    return { via: reader.via, reason: reader.reason }
  } finally {
    await reader.close()
  }
}

/**
 * Logs `mcp.fallback` whenever the audit read did NOT go over the Managed MCP Server.
 *
 * Warn when MCP was configured and we still ended up on direct SQL — that is a real fallback and
 * somebody should look at it. Info when no key was ever set, because on a clean checkout that is
 * the documented, expected path and warning about it would train the operator to ignore warnings.
 */
function noteAuditPath(reader: SqlReader): void {
  if (reader.via === 'mcp') return
  const configured = resolveMcpMode().via === 'mcp'
  emit(configured ? 'warn' : 'info', 'mcp.fallback', {
    configured,
    reason: reader.reason,
  })
}

/**
 * Demo state for the header.
 *
 * Answers 200 even when the cluster is unreachable, with `degraded` naming the reason. It used to
 * throw, which surfaced as a bare 500 and a page that could only say "server unreachable" — the one
 * situation where the operator most needs the page to explain itself was the situation where it
 * explained nothing. The endpoint a monitor should page on is `/api/health`, which does return 503.
 */
async function handleState(res: ServerResponse): Promise<void> {
  const audit = await describeAuditPath()

  let thresholds: Thresholds = FALLBACK_THRESHOLDS
  let calibrated: CalibratedThresholds | null = null
  let degraded: string | null = null
  try {
    const loaded = loadThresholds()
    thresholds = loaded.thresholds
    calibrated = loaded.calibrated
  } catch (err) {
    degraded = 'thresholds_unreadable'
    recordFailure('state.thresholds_unreadable', err)
  }

  const counts = { events: 0, arcs: 0, playbook: 0, heldOut: 0 }
  let trustStatus: string | null = null
  let latestHold: { id: string; releaseVersion: string; createdAt: Date } | null = null
  let dbReachable = true

  try {
    const [events, arcs, playbook, holds, trust] = await Promise.all([
      query<{ n: string }>('SELECT count(*) AS n FROM events'),
      query<{ n: string }>('SELECT count(*) AS n FROM actor_arcs'),
      query<{ n: string; held_out: boolean }>(
        'SELECT held_out, count(*) AS n FROM takeover_playbook GROUP BY held_out',
      ),
      query<{ id: string; release_version: string; created_at: Date }>(
        `SELECT id, release_version, created_at FROM release_hold
         WHERE package_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [config.packageId],
      ),
      query<{ status: string }>('SELECT status FROM trust_state WHERE package_id = $1', [
        config.packageId,
      ]),
    ])

    counts.events = Number(events.rows[0]?.n ?? 0)
    counts.arcs = Number(arcs.rows[0]?.n ?? 0)
    counts.playbook = Number(playbook.rows.find((r) => !r.held_out)?.n ?? 0)
    counts.heldOut = Number(playbook.rows.find((r) => r.held_out)?.n ?? 0)
    trustStatus = trust.rows[0]?.status ?? null
    latestHold = holds.rows[0]
      ? {
          id: holds.rows[0].id,
          releaseVersion: holds.rows[0].release_version,
          createdAt: holds.rows[0].created_at,
        }
      : null
  } catch (err) {
    dbReachable = false
    degraded = degraded ?? 'db_unreachable'
    recordFailure('state.db_unreachable', err)
  }

  json(res, 200, {
    packageId: config.packageId,
    provider: providerBanner(),
    offline: OFFLINE,
    thresholds,
    calibrated,
    counts,
    trustStatus,
    latestHold,
    /** Which path served the audit reads, and why — shown in the UI header. */
    audit,
    dbReachable,
    degraded,
  })
}

/**
 * The health endpoint.
 *
 * 503 for the two conditions that make a decision impossible or untrustworthy: the cluster is
 * unreachable (there is no memory to decide on) and thresholds.json is unreadable (the cut points
 * the decision uses cannot be established). A `fallback` threshold set is NOT degraded — it is a
 * documented mode, reported so it is never mistaken for a fitted one.
 *
 * `mcp` reports the CONFIGURED resolution, not a live probe. Dialling the Managed MCP Server on
 * every health check would turn a monitor into a load generator against a third-party service; the
 * live answer is in `/api/state`, which resolves it for real once per page load.
 */
async function handleHealth(res: ServerResponse): Promise<void> {
  const started = Date.now()
  let reachable = false
  let latencyMs: number | null = null
  try {
    await query('SELECT 1')
    reachable = true
    latencyMs = Date.now() - started
  } catch (err) {
    recordFailure('health.db_unreachable', err)
  }

  let thresholds: 'fitted' | 'fallback' | 'unreadable'
  try {
    thresholds = loadThresholds().calibrated ? 'fitted' : 'fallback'
  } catch (err) {
    thresholds = 'unreadable'
    recordFailure('health.thresholds_unreadable', err)
  }

  const ok = reachable && thresholds !== 'unreadable'
  json(res, ok ? 200 : 503, {
    status: ok ? 'ok' : 'degraded',
    db: { reachable, latencyMs },
    inference: OFFLINE ? 'offline' : 'bedrock',
    mcp: resolveMcpMode(),
    thresholds,
    version: VERSION,
  })
}

async function handleReplay(res: ServerResponse, corrId: string): Promise<void> {
  if (replayInFlight) {
    json(res, 409, { error: 'replay_in_flight', message: 'A replay is already running. Wait for it to finish.' })
    return
  }
  replayInFlight = true

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })

  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  try {
    const timeline = loadTimeline(config.packageId)
    const { thresholds, calibrated } = loadThresholds()

    send('start', {
      packageId: timeline.packageId,
      total: timeline.events.length,
      actors: timeline.actors,
      provider: providerBanner(),
      offline: OFFLINE,
      thresholds,
      calibrated: Boolean(calibrated),
      // Surfaced to the browser so a screenshot of a failed run carries the id needed to find the
      // matching log lines.
      corrId,
    })

    const summary = await runReplay(
      {
        packageId: timeline.packageId,
        // Unset unless SUSPECT_ACTOR pins it: the demo does not tell the agent whom to suspect.
        suspectActor: config.suspectActorOverride,
        maxCandidates: config.maxCandidates,
        windowDays: config.arcWindowDays,
        thresholds,
        events: timeline.events,
        corrId,
      },
      (step: Step) => {
        send(step.type, step)
      },
    )

    lastAssessedActor = summary.assessedActor
    send('summary', summary)
  } catch (err) {
    // The stream is already open, so an error has to travel as an event rather than a status code.
    // Same rule as everywhere else: the detail goes to the log, a reference goes to the client.
    const ref = recordFailure('replay.failed', err, { corrId })
    send('failed', { error: 'replay_failed', ref, corrId })
  } finally {
    replayInFlight = false
    res.end()
  }
}

/**
 * "Explain the retrieval" — routed through the resolved audit path.
 *
 * This used to call `explainScoped`, which goes straight to the pg pool, so the browser demo — the
 * surface the video records — could not exercise the Managed MCP Server at all no matter how it was
 * configured. `explainScopedVia` runs the same statement through whichever reader `auditReader`
 * resolved, and the response names it, so what the demo shows is the path that actually served it.
 */
async function handleExplain(res: ServerResponse, corrId: string): Promise<void> {
  // The actor this replay chose, if one has run; otherwise the inspection fallback, which only
  // matters on a cluster warmed by some earlier process.
  const actorId = lastAssessedActor ?? config.suspectActor
  const arc = await loadActorArc(config.packageId, actorId)
  if (!arc) {
    json(res, 404, { error: 'no_actor_arc', message: 'No actor arc yet — run a replay first.' })
    return
  }
  const reader = await auditReader()
  noteAuditPath(reader)
  const started = Date.now()
  try {
    const explain = await explainScopedVia(reader, config.packageId, arc.embedding)
    createLogger({ corrId, packageId: config.packageId }).info('retrieval.explained', {
      actorId,
      prefixScoped: explain.prefixScoped,
      usedVectorIndex: explain.usedVectorIndex,
      via: reader.via,
      durMs: Date.now() - started,
    })
    json(res, 200, {
      ...explain,
      // Named in the response because the arc being explained is now the agent's own choice.
      actorId,
      audit: { via: reader.via, reason: reader.reason, calls: [...reader.calls] },
    })
  } finally {
    await reader.close()
  }
}

async function handleHold(res: ServerResponse, holdId: string, corrId: string): Promise<void> {
  const reader = await auditReader()
  noteAuditPath(reader)
  try {
    const evidence = await holdEvidence(holdId, reader)
    if (!evidence) {
      json(res, 404, { error: 'no_such_hold', message: `No release_hold with id ${holdId}` })
      return
    }
    createLogger({ corrId }).info('audit.read', {
      holdId,
      via: reader.via,
      calls: reader.calls.length,
      auditTrailRows: evidence.auditTrail.length,
    })
    json(res, 200, {
      ...evidence,
      audit: { via: reader.via, reason: reader.reason, calls: [...reader.calls] },
    })
  } finally {
    await reader.close()
  }
}

function serveStatic(res: ServerResponse, file: string, type: string): void {
  try {
    const body = readFileSync(join(PUBLIC_DIR, file))
    res.writeHead(200, { 'content-type': type, 'content-length': body.length })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  }
}

/**
 * Defence in depth on top of the POST requirement.
 *
 * POST alone stops a prefetch or an `<img src>` from wiping the demo, but it does not stop a
 * cross-origin `<form method=post>` on a page the operator happens to be visiting. Browsers label
 * that request `Sec-Fetch-Site: cross-site`; same-origin fetches say `same-origin` and address-bar
 * navigations say `none`. A client that sends no such header (curl, the test suite) is allowed
 * through — this is not authentication, and the real boundary remains the loopback bind.
 */
function isCrossSite(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  return typeof site === 'string' && site !== 'same-origin' && site !== 'none'
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const route = url.pathname
  const method = req.method ?? 'GET'
  const corrId = newCorrId()
  const started = Date.now()

  const run = async (): Promise<void> => {
    if (route === '/' || route === '/index.html') return serveStatic(res, 'index.html', 'text/html; charset=utf-8')
    if (route === '/app.css') return serveStatic(res, 'app.css', 'text/css; charset=utf-8')
    if (route === '/app.js') return serveStatic(res, 'app.js', 'text/javascript; charset=utf-8')
    if (route === '/icon.svg') return serveStatic(res, 'icon.svg', 'image/svg+xml')
    if (route === '/api/health') return handleHealth(res)
    if (route === '/api/state') return handleState(res)

    if (route === '/api/replay') {
      /**
       * POST only, and this is not pedantry about verbs.
       *
       * `runReplay` starts with `resetPackage`, which DELETEs every event, arc, hold, advisory and
       * audit row for the package. As a GET that made the demo's entire memory deletable by any
       * link prefetcher, any `<img src="…/api/replay">` on any page, any URL scanner and any
       * browser that decided to speculatively load a bookmark — mid-recording.
       */
      if (method !== 'POST') {
        json(
          res,
          405,
          {
            error: 'method_not_allowed',
            message: 'POST /api/replay — it resets this package\'s memory before replaying.',
          },
          { allow: 'POST' },
        )
        return
      }
      if (isCrossSite(req)) {
        json(res, 403, { error: 'cross_site_forbidden' })
        return
      }
      return handleReplay(res, corrId)
    }

    if (route === '/api/explain') return handleExplain(res, corrId)
    if (route.startsWith('/api/hold/')) {
      /**
       * A malformed hold id is the caller's mistake, so it answers 400 — it used to answer 500.
       *
       * Two throws reached the catch-all below: `decodeURIComponent` raises URIError on a truncated
       * escape (`/api/hold/%E0%A4%A`), and `assertUuid`, called deep inside the audit read, raises
       * on anything that is not a UUID. Both came back as `internal_error` with an error-level line
       * and a stack — a page-worthy server fault reported for something no server-side change can
       * fix, inflating exactly the rate a monitor alerts on. src/handler.ts already draws this line
       * with BadRequestError; this is the same line, drawn on the demo surface.
       *
       * Validated here rather than with a local regex so there is still one definition of "is a
       * UUID" — `assertUuid` also stays where it is, guarding the SQL interpolation itself.
       * A well-formed id that simply does not exist is NOT this case: it still 404s below.
       */
      let holdId: string
      try {
        holdId = assertUuid(decodeURIComponent(route.slice('/api/hold/'.length)))
      } catch (err) {
        // warn, not error: nothing here is broken. And the message stays out of the response —
        // `assertUuid` echoes the caller's input back inside it, which is useful in a log and is
        // the one thing this server never puts on the wire.
        emit('warn', 'hold.invalid_id', {
          corrId,
          route,
          reason: err instanceof URIError ? 'malformed_escape' : 'not_a_uuid',
        })
        json(res, 400, { error: 'invalid_hold_id', corrId })
        return
      }
      return handleHold(res, holdId, corrId)
    }
    json(res, 404, { error: 'not_found' })
  }

  run()
    .catch((err) => {
      /**
       * The one rule: `err.message` never crosses the wire.
       *
       * A pg failure message carries the cluster hostname, its IP, the port and the SQL user;
       * `assertUuid` echoes back whatever the caller sent. `recordFailure` puts the whole thing —
       * message and stack — in the log and hands back a reference the caller can quote.
       */
      const ref = recordFailure('request.failed', err, { corrId, route, method })
      if (!res.headersSent) json(res, 500, { error: 'internal_error', ref, corrId })
      else res.end()
    })
    .finally(() => {
      emit('info', 'http.request', {
        corrId,
        method,
        route,
        status: res.statusCode,
        durMs: Date.now() - started,
      })
    })
})

/**
 * The corpus/model check, run once at boot instead of at the moment a decision is due.
 *
 * `assertPlaybookModel` was exported so an entry point could call it and no entry point ever did:
 * its only caller was the empty-match path inside `matchPlaybook`. A process pointed at a corpus
 * embedded by a different model therefore started, reported health `ok`, and refused only once a
 * release was being assessed — mid-recording, in the demo's case. Its thrown message is a complete
 * operator instruction (re-seed, or point the process back at the model that wrote the corpus), so
 * a boot that dies printing it is worth more than a server that comes up unable to decide.
 *
 * Top-level await rather than the `listen` callback, which is synchronous and cannot await it.
 *
 * Honest about the limit: this only fires when a corpus embedded by a DIFFERENT model exists. An
 * empty playbook passes silently, by design — so it is not a "did you run `npm run seed`?" check
 * and an untouched cluster will sail through it.
 */
try {
  await assertPlaybookModel()
} catch (err) {
  /**
   * A cluster that could not answer the query is not the same as a check that said no, and it does
   * not stop the boot. Unreachable-at-startup — or a table being recreated by a migration at that
   * instant — is exactly what `/api/health` exists to report as 503 and what `/api/state` degrades
   * for, and neither can report anything from a process that refused to listen.
   *
   * Discriminated on the message because there is no error class to test: memory.ts throws a plain
   * `Error`. If that message is ever reworded this stops being fatal at boot, which is the safe
   * direction to fail — the same check still runs on the empty-match path before any decision.
   */
  if (err instanceof Error && /embedding model mismatch/i.test(err.message)) throw err
  recordFailure('startup.playbook_model_uncheckable', err)
}

server.listen(config.port, BIND_HOST, () => {
  // stdout stays human: this banner is what a judge sees in the terminal during a recording. The
  // machine-readable stream is stderr — see src/log.ts.
  console.log(`Sleeper demo on http://${BIND_HOST}:${config.port}`)
  console.log(providerBanner())
  if (OFFLINE) {
    console.log('OFFLINE MODE — deterministic stand-in for Bedrock. Wiring only, no quality claims.')
  }
  if (BIND_HOST !== '127.0.0.1' && BIND_HOST !== 'localhost') {
    console.log(
      `WARNING: bound to ${BIND_HOST}, not loopback. /api/replay resets this package's memory and ` +
        'there is no authentication on this server.',
    )
  }
  emit('info', 'server.listening', {
    host: BIND_HOST,
    port: config.port,
    version: VERSION,
    inference: OFFLINE ? 'offline' : 'bedrock',
    mcp: resolveMcpMode().via,
  })
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      void closePool().finally(() => process.exit(0))
    })
  })
}
