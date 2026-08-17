/**
 * Every route the demo server answers, and the audit-reader cache they share.
 *
 * Split out of src/server.ts, which now does nothing but boot: the corpus/model check, one
 * `createServer`, one `listen`, and the signal handlers. The reason is not tidiness. Route logic
 * that lives in a module which starts listening as a side effect of import can only be exercised
 * through a socket — every assertion about a 400, a redaction or a lease count had to pay for a
 * child process, a port and a real cluster, and the coverage instrumentation could not see any of
 * it. Here the same logic is a function you can call with a fake `res`, so the branches that are
 * genuinely awkward to provoke over HTTP (an MCP session whose `close()` rejects, a `tools/list`
 * that fails mid-burst, a playbook table with no held-out rows) get a test instead of a shrug.
 *
 * What did NOT move, because it cannot be established this way: that GET /api/replay is truly
 * unreachable and that the process binds loopback only. Those are properties of a running server,
 * and tests/server.test.ts still boots one to prove them.
 *
 * Dependencies arrive through `createRouter`'s overrides rather than being reached for directly.
 * That is the same argument as above pointed at the collaborators: `holdEvidence` failing, or an
 * `auditReader()` that rejects, are the paths a release gate is judged on, and neither is
 * reproducible by arranging a cluster into the right mood. Production wiring is one object
 * literal — DEFAULT_ROUTE_DEPS — so there is exactly one place where the real thing is named, and
 * a test that forgets to override something gets the real thing, loudly, rather than a stub.
 */
import { type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'
import { loadThresholds, loadTimeline, type CalibratedThresholds, type Timeline } from './corpus.js'
import { FALLBACK_THRESHOLDS, type Thresholds } from './decide.js'
import { OFFLINE, providerBanner } from './embeddings.js'
import { runReplay, type ReplayOptions, type ReplaySummary, type Step } from './agent.js'
import {
  auditReader,
  explainScopedVia,
  holdEvidence,
  loadActorArc,
  type ExplainResult,
  type HoldEvidence,
} from './memory.js'
import { assertUuid, resolveMcpMode, type McpMode, type SqlReader } from './mcp.js'
import { query } from './db.js'
import { createLogger, emit, newCorrId, recordFailure } from './log.js'

const here = dirname(fileURLToPath(import.meta.url))
export const PUBLIC_DIR = join(here, '..', 'public')
export const PACKAGE_JSON_PATH = join(here, '..', 'package.json')

/**
 * Reported by `/api/health` so an operator can tell which build answered.
 *
 * Read from package.json rather than hardcoded — a version constant that has to be edited by hand
 * is a version constant that is wrong. Unreadable is not fatal: health is more useful degraded
 * than absent.
 *
 * `read` is a parameter so both outcomes are reachable without arranging for the real package.json
 * to be missing, which no test should be doing to a repo.
 */
export function readVersion(read: (path: string) => string, path: string): string {
  try {
    const pkg = JSON.parse(read(path)) as { version?: string }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

export const VERSION = readVersion((path) => readFileSync(path, 'utf8'), PACKAGE_JSON_PATH)

/**
 * How long one resolved audit reader is reused before the path is resolved again.
 *
 * This used to be per request, and per request it dialled a third party. `auditReader()` →
 * `resolveSqlReader` opens a Streamable HTTP session to `https://cockroachlabs.cloud/mcp` and reads
 * `tools/list` before it can answer, so with COCKROACH_MCP_API_KEY set, `/api/state` — the call the
 * page makes on load, before anything has been clicked — measured 0.90–1.06 s against
 * `/api/health`'s 0.0015 s, and `/api/explain` 1.6 s idle. A page load's latency was a round trip
 * to somebody else's cloud, and the suite had already started timing out on it.
 *
 * 30 seconds, and the number follows from what the resolution is a function of. Two inputs:
 * process env (COCKROACH_MCP_API_KEY, COCKROACH_CLUSTER_ID, SLEEPER_MCP) — which cannot change
 * inside a running process at all — and whether cockroachlabs.cloud is reachable, which can. So the
 * TTL is only ever trading staleness about *reachability*:
 *
 *   - long enough that one page load (state + explain + a hold read) and a judge clicking around
 *     for a few seconds all share a single resolution, which is the whole point;
 *   - short enough that a transient MCP outage self-heals inside one demo beat rather than pinning
 *     the header to "direct SQL" for the rest of the process — 30 s is well under the time it takes
 *     to notice a wrong banner and re-run;
 *   - short enough that a shared MCP session is not being held open long enough for server-side
 *     idle expiry to be the realistic failure mode (and if it is one anyway, a failed call retires
 *     the session — see `releaseAuditSession`).
 *
 * Honest about the cost: `audit.via`/`audit.reason` are now up to 30 s stale with respect to MCP
 * reachability. They are never stale about which path *served this request* — that is read off the
 * reader that actually ran the statement, which is the property the UI header claims.
 *
 * SLEEPER_AUDIT_TTL_MS overrides it, and `0` restores the old resolve-per-request behaviour exactly
 * — which is how the fallback and recovery paths above were exercised without waiting 30 s for each
 * one. An unparseable value falls back to the default rather than to `NaN`, because every comparison
 * against `NaN` is false and the quiet result would be a cache that never hits.
 */
export function resolveAuditTtlMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.SLEEPER_AUDIT_TTL_MS ?? 30_000)
  return Number.isFinite(raw) && raw >= 0 ? raw : 30_000
}

export const AUDIT_READER_TTL_MS = resolveAuditTtlMs(process.env)

/**
 * One resolved reader, shared by every request inside a TTL window.
 *
 * Lease-counted rather than closed on a timer. The MCP reader owns a live session, and a session
 * closed underneath a request that is mid-statement turns a cache into a new class of 500 — so a
 * superseded session is marked `retired` (no new leases) and closed by whichever request lets go of
 * it last.
 */
export type AuditSession = {
  reader: SqlReader
  /** Instant after which this session is no longer handed out. */
  expiresAt: number
  /** Requests currently holding it. */
  leases: number
  /** Superseded or invalidated: hand out no more leases, close at zero. */
  retired: boolean
  /** `close()` already called — the retire path can be reached twice. */
  closing: boolean
}

/**
 * The audit-session cache, as its own thing.
 *
 * It is the only real machinery in this module — a TTL, a lease count and a close that must happen
 * exactly once, never mid-statement — and it is worth being able to drive directly. Retiring a
 * session twice, or letting go of a lease while another request still holds one, are one-line
 * mistakes with a symptom (`MCP session closed` from inside an unrelated request, minutes later)
 * that no HTTP-level test would attribute correctly.
 */
export type AuditSessionCache = {
  /** Leases the current session, resolving one if the cache is cold, expired or invalidated. */
  acquire: () => Promise<AuditSession>
  /** Gives a lease back. `failed` takes the session out of the cache — see `release` below. */
  release: (session: AuditSession, failed: boolean) => void
  /** Stops handing a session out; closes it once its last lease is gone. */
  retire: (session: AuditSession) => void
  /** The session currently on offer, if any. */
  current: () => AuditSession | null
  /** Runs `use` against a leased reader, releasing it — never closing the shared one — afterwards. */
  with: <T>(use: (leased: LeasedReader) => Promise<T>) => Promise<T>
}

/** A leased reader plus the calls THIS request made through it. */
export type LeasedReader = {
  reader: SqlReader
  /**
   * The shared reader's `calls` log, sliced from where this request found it.
   *
   * Two honest limits. `tools/list` is pushed during connect, so it belongs to the session rather
   * than to any one request and no longer appears here — `calls` is now "what this request ran",
   * which is what the field claimed all along. And two genuinely concurrent audit reads over the
   * same session will each see the other's calls in their slice; this is a single-page demo server
   * where that does not arise, and the alternative is a per-request client, i.e. the defect.
   */
  calls: () => string[]
}

/**
 * Only the part of `db.query` the routes use: rows out of a statement.
 *
 * Narrower than `typeof query` deliberately — a route reads `.rows` and nothing else, and a test
 * double should not have to fabricate a pg `QueryResult`'s command, oid and field descriptors to
 * stand in for one.
 */
export type SqlQuery = <T extends Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<{ rows: T[] }>

/** Everything the routes reach outside themselves. See the module comment for why it is a bag. */
export type RouteDeps = {
  query: SqlQuery
  auditReader: () => Promise<SqlReader>
  loadThresholds: () => { thresholds: Thresholds; calibrated: CalibratedThresholds | null }
  loadTimeline: (packageId: string) => Timeline
  runReplay: (opts: ReplayOptions, onStep: (step: Step) => void) => Promise<ReplaySummary>
  loadActorArc: (
    packageId: string,
    actorId: string,
  ) => Promise<{ id: string; arcSummary: string; embedding: number[] } | null>
  explainScopedVia: (
    reader: SqlReader,
    packageId: string,
    embedding: number[],
  ) => Promise<ExplainResult>
  holdEvidence: (holdId: string, reader: SqlReader) => Promise<HoldEvidence | null>
  resolveMcpMode: () => McpMode
  /** Reads one file out of PUBLIC_DIR. A dep so a 404 does not require deleting the demo page. */
  readStatic: (file: string) => Buffer
  version: string
  auditTtlMs: number
  /**
   * `OFFLINE` in production. Injected because it is fixed for the life of the process by an env var
   * read at import, so the Bedrock half of every `offline ? … : …` below is otherwise unreachable
   * in a suite that runs offline — and running the suite against real Bedrock to cover a string
   * literal is not a trade anyone should make.
   */
  offline: boolean
  providerBanner: () => string
}

export const DEFAULT_ROUTE_DEPS: RouteDeps = {
  query,
  auditReader,
  loadThresholds,
  loadTimeline,
  runReplay,
  loadActorArc,
  explainScopedVia,
  holdEvidence,
  resolveMcpMode,
  readStatic: (file) => readFileSync(join(PUBLIC_DIR, file)),
  version: VERSION,
  auditTtlMs: AUDIT_READER_TTL_MS,
  offline: OFFLINE,
  providerBanner,
}

export function json(
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
 * Strips cluster UUIDs out of a string bound for an unauthenticated response.
 *
 * `resolveMcpMode`'s reason sentence names the pinned cluster — "session pinned to cluster
 * <uuid> via the mcp-cluster-id header" — and `/api/health` returned it verbatim, so the full
 * CockroachDB Cloud cluster id was readable by anything that could GET a health endpoint. Low
 * severity while the server is on loopback, but SLEEPER_BIND_HOST is a documented override and a
 * health endpoint is precisely the route people point a monitor at.
 *
 * Redacting the identifier rather than rewriting the sentence keeps the operator-useful half — that
 * the session IS pinned, and by which header — and keeps it useful if the sentence is ever reworded
 * upstream; `clusterPinned` carries the same fact in machine-readable form. A pattern match, not a
 * comparison against the configured id, so the id cannot escape through a *different* string (an
 * MCP error message quoting it, say) that happens to reach the same response.
 */
export function withoutClusterId(text: string): string {
  return text.replace(
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
    '<redacted>',
  )
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
export function isCrossSite(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  return typeof site === 'string' && site !== 'same-origin' && site !== 'none'
}

export function createAuditSessionCache(deps: {
  auditReader: () => Promise<SqlReader>
  ttlMs: number
  /** Called once per resolution, with the reader that won. See `noteAuditPath`. */
  onResolved: (reader: SqlReader) => void
}): AuditSessionCache {
  let auditSession: AuditSession | null = null

  /**
   * The resolution in flight, if any, so a burst of requests arriving on a cold cache produces ONE
   * dial rather than one each. Cleared on both settle paths.
   */
  let auditResolving: Promise<AuditSession> | null = null

  function closeIfIdle(session: AuditSession): void {
    if (!session.retired || session.leases > 0 || session.closing) return
    session.closing = true
    // A reader that cannot be closed is not worth failing a request over — it is already off the
    // cache and unreachable — but it is worth a line, because leaking MCP sessions is how a long
    // demo run ends up rate-limited.
    void session.reader.close().catch((err) => recordFailure('audit.reader_close_failed', err))
  }

  function retire(session: AuditSession): void {
    session.retired = true
    if (auditSession === session) auditSession = null
    closeIfIdle(session)
  }

  /**
   * Hands out a lease on a resolved reader, resolving one if the cache is cold or expired.
   *
   * Nothing is cached on the failure path: if `auditReader()` rejects, `auditResolving` is cleared,
   * `auditSession` stays as it was (null, since an expired session is retired before this runs) and
   * the next request tries again. A *fallback* is not a rejection — `resolveSqlReader` answers a
   * failed MCP connect with a direct-SQL reader whose `reason` names the error — and that IS cached,
   * for the same TTL and no longer: reported as the direct path it is, never as MCP, and re-resolved
   * within 30 s so a transient outage cannot wedge the process into permanent fallback.
   */
  async function acquire(): Promise<AuditSession> {
    const live = auditSession
    if (live && !live.retired && live.expiresAt > Date.now()) {
      live.leases++
      return live
    }
    // Expired or already invalidated: stop handing it out now, close it when its last reader is done.
    if (live) retire(live)

    if (!auditResolving) {
      auditResolving = deps
        .auditReader()
        .then((reader) => {
          deps.onResolved(reader)
          const session: AuditSession = {
            reader,
            expiresAt: Date.now() + deps.ttlMs,
            leases: 0,
            retired: false,
            closing: false,
          }
          auditSession = session
          return session
        })
        .finally(() => {
          auditResolving = null
        })
    }

    const session = await auditResolving
    session.leases++
    return session
  }

  /**
   * `failed` is not bookkeeping: it is the recovery path.
   *
   * A shared reader is state, and the one thing that can go wrong with reusing it — an MCP session the
   * far end has since dropped — presents as a throw from the statement, not from the resolution. So a
   * request that failed while holding the session takes the session out of the cache on its way out,
   * and the next request resolves a fresh one. It does not retry in-band: a second dial inside the
   * same request is the cost this cache exists to remove, and one 500 is cheaper than reintroducing it
   * on every genuinely-bad statement.
   */
  function release(session: AuditSession, failed: boolean): void {
    session.leases--
    if (failed) retire(session)
    else closeIfIdle(session)
  }

  /**
   * Two explicit `release` calls rather than one in a `finally`.
   *
   * The `finally` version needed a `failed` flag to tell the two paths apart, and the flag is the
   * whole reason it read as bookkeeping — `release(session, failed)` says nothing about which case
   * is which. This says it: a statement that came back releases the lease, a statement that threw
   * releases it AND invalidates the session, because the session is the suspect. Exactly one
   * `release` on every path out, which is the property the lease count depends on.
   */
  async function withReader<T>(use: (leased: LeasedReader) => Promise<T>): Promise<T> {
    const session = await acquire()
    const from = session.reader.calls.length
    try {
      const result = await use({
        reader: session.reader,
        calls: () => session.reader.calls.slice(from),
      })
      release(session, false)
      return result
    } catch (err) {
      release(session, true)
      throw err
    }
  }

  return { acquire, release, retire, current: () => auditSession, with: withReader }
}

export type Router = {
  /**
   * The request listener handed to `createServer`.
   *
   * Returns the promise the response is written from. `createServer` ignores it — a `RequestListener`
   * is declared void — but it is the difference between a test awaiting the response and a test
   * polling for it, and a polled assertion is a flaky assertion. It never rejects: the catch-all
   * below is the last word on every request.
   */
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  /**
   * Lets go of the cached audit session, without closing it out from under a request that is still
   * using it. Called on the way down — see the signal handlers in src/server.ts.
   */
  shutdown: () => void
}

/**
 * Builds an independent router: its own audit-session cache, its own replay lock, its own memory
 * of which actor the last replay assessed.
 *
 * Per-router rather than per-module state, because module-level `let`s are shared by every test in
 * a file and the lease/TTL logic below is exactly the kind of thing that passes in isolation and
 * fails in a suite. One process still only ever builds one of these.
 */
export function createRouter(overrides: Partial<RouteDeps> = {}): Router {
  const deps: RouteDeps = { ...DEFAULT_ROUTE_DEPS, ...overrides }

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

  const auditCache = createAuditSessionCache({
    auditReader: () => deps.auditReader(),
    ttlMs: deps.auditTtlMs,
    onResolved: (reader) => noteAuditPath(reader),
  })
  const withAuditReader = auditCache.with

  /**
   * Resolves the audit read path and reports which one it is.
   *
   * Reads `via`/`reason` off the reader that is actually in force rather than off `resolveMcpMode`,
   * so a configured-but-unreachable MCP path still reports `direct` here — the cache changes when the
   * resolution happens, not what it is allowed to claim.
   */
  async function describeAuditPath(): Promise<{ via: 'mcp' | 'direct'; reason: string }> {
    return withAuditReader(async ({ reader }) => ({
      via: reader.via,
      reason: withoutClusterId(reader.reason),
    }))
  }

  /**
   * Logs `mcp.fallback` whenever the resolved audit path is NOT the Managed MCP Server.
   *
   * Warn when MCP was configured and we still ended up on direct SQL — that is a real fallback and
   * somebody should look at it. Info when no key was ever set, because on a clean checkout that is
   * the documented, expected path and warning about it would train the operator to ignore warnings.
   *
   * Called once per *resolution* rather than once per request, now that a resolution serves many
   * requests. That is also the more accurate framing — falling back is something that happened once,
   * at a known instant, and `ttlMs` says how long the decision stands before it is retried.
   */
  function noteAuditPath(reader: SqlReader): void {
    if (reader.via === 'mcp') return
    const configured = deps.resolveMcpMode().via === 'mcp'
    emit(configured ? 'warn' : 'info', 'mcp.fallback', {
      configured,
      reason: reader.reason,
      ttlMs: deps.auditTtlMs,
    })
  }

  /** `resolveMcpMode`, with the cluster id taken out — see `withoutClusterId`. */
  function publicMcpMode(): Record<string, unknown> {
    const mode = deps.resolveMcpMode()
    if (mode.via === 'direct') return { via: mode.via, reason: withoutClusterId(mode.reason) }
    return {
      via: mode.via,
      endpoint: mode.endpoint,
      clusterPinned: mode.clusterPinned,
      reason: withoutClusterId(mode.reason),
    }
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
      const loaded = deps.loadThresholds()
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
        /**
         * Scoped to the configured package, and not only for the plan.
         *
         * `SELECT count(*) FROM events` is a FULL SCAN — EXPLAIN says
         * `table: events@events_event_key_idx, spans: FULL SCAN` — and it was also answering the wrong
         * question. Everything else on this panel is this package's (`latestHold`, `trustStatus`), the
         * label above the number reads "events in memory", and on any cluster that has ever run a test
         * or a second package the global count is larger than the memory the demo is about: 50 rows
         * here for a package holding 25.
         *
         * With the predicate the planner takes a bounded prefix span off one of the two
         * package-leading indexes (`events_pkg_actor_time_idx` here, `events_pkg_time_idx` equally
         * eligible — either is a span, not a scan). Still a count, so it is O(rows in the package);
         * this buys the right answer and the right span, not a constant-time counter.
         */
        deps.query<{ n: string }>('SELECT count(*) AS n FROM events WHERE package_id = $1', [
          config.packageId,
        ]),
        // Same argument, same shape: served by the `(package_id, actor_id)` unique index.
        deps.query<{ n: string }>('SELECT count(*) AS n FROM actor_arcs WHERE package_id = $1', [
          config.packageId,
        ]),
        /**
         * This one stays unfiltered, deliberately.
         *
         * The playbook is the CROSS-package corpus of known takeovers — the whole point is that it
         * describes packages other than the one being assessed, so `WHERE package_id = $1` would
         * return zero and the header would report an empty corpus for a demo that just matched against
         * it. It is a FULL SCAN and will stay one: it is the seeded corpus, bounded at tens of rows
         * (16 on this cluster), and the only predicate that could bound it further is `held_out`, which
         * is the column being grouped BY. CockroachDB's own index recommendation here is an index on
         * `held_out` — a two-value column over 16 rows, which is not a fix, it is a slower plan with
         * more moving parts.
         */
        deps.query<{ n: string; held_out: boolean }>(
          'SELECT held_out, count(*) AS n FROM takeover_playbook GROUP BY held_out',
        ),
        deps.query<{ id: string; release_version: string; created_at: Date }>(
          `SELECT id, release_version, created_at FROM release_hold
         WHERE package_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [config.packageId],
        ),
        deps.query<{ status: string }>('SELECT status FROM trust_state WHERE package_id = $1', [
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
      provider: deps.providerBanner(),
      offline: deps.offline,
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
   * live answer is in `/api/state`, which resolves it for real (at most once per TTL window — see
   * AUDIT_READER_TTL_MS).
   *
   * It reports it through `publicMcpMode` rather than verbatim: this route is unauthenticated and is
   * the one an operator exposes on purpose, so the cluster identifier does not go in it.
   */
  async function handleHealth(res: ServerResponse): Promise<void> {
    const started = Date.now()
    let reachable = false
    let latencyMs: number | null = null
    try {
      await deps.query('SELECT 1')
      reachable = true
      latencyMs = Date.now() - started
    } catch (err) {
      recordFailure('health.db_unreachable', err)
    }

    let thresholds: 'fitted' | 'fallback' | 'unreadable'
    try {
      thresholds = deps.loadThresholds().calibrated ? 'fitted' : 'fallback'
    } catch (err) {
      thresholds = 'unreadable'
      recordFailure('health.thresholds_unreadable', err)
    }

    const ok = reachable && thresholds !== 'unreadable'
    json(res, ok ? 200 : 503, {
      status: ok ? 'ok' : 'degraded',
      db: { reachable, latencyMs },
      inference: deps.offline ? 'offline' : 'bedrock',
      mcp: publicMcpMode(),
      thresholds,
      version: deps.version,
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
      const timeline = deps.loadTimeline(config.packageId)
      const { thresholds, calibrated } = deps.loadThresholds()

      send('start', {
        packageId: timeline.packageId,
        total: timeline.events.length,
        actors: timeline.actors,
        provider: deps.providerBanner(),
        offline: deps.offline,
        thresholds,
        calibrated: Boolean(calibrated),
        // Surfaced to the browser so a screenshot of a failed run carries the id needed to find the
        // matching log lines.
        corrId,
      })

      const summary = await deps.runReplay(
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
    const arc = await deps.loadActorArc(config.packageId, actorId)
    if (!arc) {
      json(res, 404, { error: 'no_actor_arc', message: 'No actor arc yet — run a replay first.' })
      return
    }
    await withAuditReader(async ({ reader, calls }) => {
      const started = Date.now()
      const explain = await deps.explainScopedVia(reader, config.packageId, arc.embedding)
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
        audit: { via: reader.via, reason: withoutClusterId(reader.reason), calls: calls() },
      })
    })
  }

  async function handleHold(res: ServerResponse, holdId: string, corrId: string): Promise<void> {
    await withAuditReader(async ({ reader, calls }) => {
      const evidence = await deps.holdEvidence(holdId, reader)
      if (!evidence) {
        json(res, 404, { error: 'no_such_hold', message: `No release_hold with id ${holdId}` })
        return
      }
      createLogger({ corrId }).info('audit.read', {
        holdId,
        via: reader.via,
        calls: calls().length,
        auditTrailRows: evidence.auditTrail.length,
      })
      json(res, 200, {
        ...evidence,
        audit: { via: reader.via, reason: withoutClusterId(reader.reason), calls: calls() },
      })
    })
  }

  function serveStatic(res: ServerResponse, file: string, type: string): void {
    try {
      const body = deps.readStatic(file)
      res.writeHead(200, { 'content-type': type, 'content-length': body.length })
      res.end(body)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    }
  }

  function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

    return run()
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
  }

  function shutdown(): void {
    // The cached reader outlives a request now, so shutdown is the one place that has to let go of
    // it. `retire` closes it once its last lease is released, so an in-flight audit read finishes
    // rather than losing its session on the way out; `server.close` is already waiting for that
    // request anyway.
    const live = auditCache.current()
    if (live) auditCache.retire(live)
  }

  return { handle, shutdown }
}
