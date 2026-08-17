/**
 * The HTTP surface, in process.
 *
 * These are the tests tests/server.test.ts could not write. That file boots a real child process
 * against a real cluster, which is the only way to establish the two properties it exists for —
 * GET /api/replay is unreachable, and the process binds loopback only — and it is the wrong
 * instrument for everything else: a branch like "the MCP session's `close()` rejected" or "the
 * playbook table came back with no held-out rows" is not something you arrange by putting a cluster
 * in the right mood, and none of it could be measured, because v8 cannot instrument a child.
 *
 * So the routes moved to src/routes.ts behind `createRouter`, and here they are called directly
 * with a fake `req`/`res` and fake collaborators. Nothing is mocked by module interception: every
 * dependency is a named field of RouteDeps, so a test that forgets one gets the real thing rather
 * than a silently-undefined stub, and reading a test tells you exactly which collaborators the
 * route under test actually has.
 *
 * No cluster needed, and deliberately so — this file must stay green on a clean checkout.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  AUDIT_READER_TTL_MS,
  DEFAULT_ROUTE_DEPS,
  PACKAGE_JSON_PATH,
  PUBLIC_DIR,
  VERSION,
  createAuditSessionCache,
  createRouter,
  isCrossSite,
  json,
  readVersion,
  resolveAuditTtlMs,
  withoutClusterId,
  type RouteDeps,
  type Router,
  type SqlQuery,
} from '../src/routes.js'
import { config } from '../src/config.js'
import { FALLBACK_THRESHOLDS } from '../src/decide.js'
import { setLogSink, type LogLine } from '../src/log.js'
import type { SqlReader } from '../src/mcp.js'
import type { HoldEvidence } from '../src/memory.js'
import type { ReplayOptions, ReplaySummary, Step } from '../src/agent.js'
import type { Timeline } from '../src/corpus.js'

// ─────────────────────────────────────────────────────────────────────────────
// Doubles
// ─────────────────────────────────────────────────────────────────────────────

/** Captured log lines, so the assertions about `corrId` and warn-vs-error are real assertions. */
let lines: LogLine[] = []
let restoreSink: (line: LogLine) => void

beforeEach(() => {
  lines = []
  restoreSink = setLogSink((line) => lines.push(line))
})

afterEach(() => {
  setLogSink(restoreSink)
})

function eventsLogged(): string[] {
  return lines.map((l) => l.event)
}

type StubReader = SqlReader & { closeCalls: number }

function stubReader(
  opts: { via?: 'mcp' | 'direct'; reason?: string; closeRejects?: boolean } = {},
): StubReader {
  const calls: string[] = []
  const reader: StubReader = {
    via: opts.via ?? 'direct',
    reason: opts.reason ?? 'stub reader — no MCP key in this test',
    calls,
    closeCalls: 0,
    async select() {
      calls.push('SQL SELECT')
      return []
    },
    async explain() {
      calls.push('SQL EXPLAIN')
      return 'plan'
    },
    async tableSchema() {
      calls.push('SQL SHOW CREATE TABLE')
      return 'schema'
    },
    async close() {
      reader.closeCalls++
      if (opts.closeRejects) throw new Error('session already gone')
    },
  }
  return reader
}

/**
 * A `res` that records rather than writes.
 *
 * `endThrowsOnce` exists for one branch and is not a contrivance: a client that goes away between
 * the header and the body makes `res.end` throw ERR_STREAM_DESTROYED, and what must happen then is
 * that the catch-all recognises the headers are already out and does NOT try to write a 500 body
 * over the top of them.
 */
function fakeRes(opts: { endThrowsOnce?: boolean } = {}): {
  res: ServerResponse
  rec: {
    status: number
    statusCode: number
    headers: Record<string, string | number>
    body: string
    chunks: string[]
    ended: number
    headersSent: boolean
    json: () => Record<string, any>
    events: () => { event: string; data: Record<string, any> }[]
  }
} {
  let endThrows = opts.endThrowsOnce ?? false
  const rec = {
    status: 0,
    statusCode: 200,
    headers: {} as Record<string, string | number>,
    body: '',
    chunks: [] as string[],
    ended: 0,
    headersSent: false,
    json: (): Record<string, any> => JSON.parse(rec.body) as Record<string, any>,
    /** Parses the SSE frames written by `/api/replay`. */
    events: (): { event: string; data: Record<string, any> }[] =>
      rec.chunks.map((chunk) => {
        const [head, tail] = chunk.split('\n')
        return {
          event: head!.replace('event: ', ''),
          data: JSON.parse(tail!.replace('data: ', '')) as Record<string, any>,
        }
      }),
  }
  const res = {
    get headersSent() {
      return rec.headersSent
    },
    get statusCode() {
      return rec.statusCode
    },
    writeHead(status: number, headers: Record<string, string | number>) {
      rec.status = status
      rec.statusCode = status
      rec.headers = { ...headers }
      rec.headersSent = true
      return res
    },
    write(chunk: unknown) {
      rec.chunks.push(String(chunk))
      return true
    },
    end(payload?: unknown) {
      rec.ended++
      if (endThrows) {
        endThrows = false
        throw new Error('ERR_STREAM_DESTROYED')
      }
      if (payload !== undefined) rec.body = String(payload)
      return res
    },
  }
  return { res: res as unknown as ServerResponse, rec }
}

function fakeReq(init: { url?: string; method?: string; headers?: Record<string, string> } = {}): IncomingMessage {
  return {
    url: init.url,
    method: init.method,
    headers: init.headers ?? {},
  } as unknown as IncomingMessage
}

type StateRows = {
  events?: Record<string, unknown>[]
  arcs?: Record<string, unknown>[]
  playbook?: Record<string, unknown>[]
  holds?: Record<string, unknown>[]
  trust?: Record<string, unknown>[]
}

const HOLD_ROW = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  release_version: '5.6.0',
  created_at: new Date('2024-03-29T00:00:00Z'),
}

/** A `query` that answers each of `/api/state`'s five statements by matching its text. */
function stubQuery(rows: StateRows = {}): SqlQuery {
  return async <T extends Record<string, unknown>>(sql: string): Promise<{ rows: T[] }> => {
    if (sql.includes('FROM events')) return { rows: (rows.events ?? [{ n: '25' }]) as T[] }
    if (sql.includes('FROM actor_arcs')) return { rows: (rows.arcs ?? [{ n: '3' }]) as T[] }
    if (sql.includes('takeover_playbook')) {
      return {
        rows: (rows.playbook ?? [
          { held_out: false, n: '16' },
          { held_out: true, n: '4' },
        ]) as T[],
      }
    }
    if (sql.includes('release_hold')) return { rows: (rows.holds ?? [HOLD_ROW]) as T[] }
    if (sql.includes('trust_state')) return { rows: (rows.trust ?? [{ status: 'held' }]) as T[] }
    return { rows: [] as T[] }
  }
}

const TIMELINE: Timeline = {
  packageId: 'xz-utils',
  actors: { 'jia-tan': 'the account under assessment' },
  provenance: { source: 'test fixture' },
  events: [
    {
      packageId: 'xz-utils',
      actorId: 'jia-tan',
      kind: 'commit',
      content: 'small portability fix',
      occurredAt: '2023-01-01T00:00:00Z',
    },
  ],
}

const SUMMARY: ReplaySummary = {
  ingested: 1,
  assessedActor: 'jia-tan',
  assessedActors: ['jia-tan'],
  holdId: null,
  heldAt: null,
  releaseVersion: null,
  decision: null,
  prefixScoped: true,
  decisionLatencyMs: null,
}

const EVIDENCE: HoldEvidence = {
  hold: {
    id: HOLD_ROW.id,
    packageId: 'xz-utils',
    releaseVersion: '5.6.0',
    reason: 'arc matches a known takeover',
    similarity: 0.87,
    createdAt: HOLD_ROW.created_at,
    resolution: null,
    resolvedBy: null,
    resolvedAt: null,
    resolutionNote: null,
  },
  matchedArc: null,
  trustStatus: 'held',
  advisories: [],
  auditTrail: [{ actor: 'sleeper', action: 'hold', detail: null, createdAt: HOLD_ROW.created_at }],
}

/**
 * Every dependency stubbed to its happy answer. A test names only what it is about.
 *
 * `reader` is shared across the router's whole life on purpose — that is what the cache does, and
 * asserting on `reader.calls` is how a test sees which statements a request ran.
 */
function makeRouter(
  overrides: Partial<RouteDeps> = {},
): { router: Router; reader: StubReader; resolutions: () => number } {
  const reader = stubReader()
  let resolutions = 0
  const router = createRouter({
    query: stubQuery(),
    auditReader: async () => {
      resolutions++
      return reader
    },
    loadThresholds: () => ({ thresholds: FALLBACK_THRESHOLDS, calibrated: null }),
    loadTimeline: () => TIMELINE,
    runReplay: async () => SUMMARY,
    loadActorArc: async () => ({ id: 'arc-1', arcSummary: 'summary', embedding: [0.1, 0.2] }),
    explainScopedVia: async (r) => {
      await r.explain('SELECT 1')
      return { plan: 'prefix spans', prefixScoped: true, usedVectorIndex: true }
    },
    holdEvidence: async (_id, r) => {
      await r.select('SELECT 1')
      return EVIDENCE
    },
    resolveMcpMode: () => ({ via: 'direct', reason: 'COCKROACH_MCP_API_KEY is not set' }),
    readStatic: () => Buffer.from('<!doctype html>stub'),
    version: '9.9.9',
    auditTtlMs: 30_000,
    offline: true,
    providerBanner: () => 'inference: stub',
    ...overrides,
  })
  return { router, reader, resolutions: () => resolutions }
}

async function request(
  router: Router,
  init: { url?: string; method?: string; headers?: Record<string, string> } = {},
  resOpts: { endThrowsOnce?: boolean } = {},
): Promise<ReturnType<typeof fakeRes>['rec']> {
  const { res, rec } = fakeRes(resOpts)
  await router.handle(fakeReq(init), res)
  return rec
}

/** A promise plus its resolvers, for the concurrency and burst tests. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('readVersion', () => {
  it('reports the version out of package.json', () => {
    expect(readVersion(() => '{"version":"1.2.3"}', 'pkg.json')).toBe('1.2.3')
  })

  it("says 'unknown' rather than undefined when the field is absent", () => {
    expect(readVersion(() => '{"name":"sleeper"}', 'pkg.json')).toBe('unknown')
  })

  it("says 'unknown' rather than dying when the file is unreadable or not JSON", () => {
    // Health is more useful degraded than absent — this must never be the thing that stops a boot.
    expect(
      readVersion(() => {
        throw new Error('ENOENT')
      }, 'pkg.json'),
    ).toBe('unknown')
    expect(readVersion(() => 'not json at all', 'pkg.json')).toBe('unknown')
  })

  it('reads the real package.json at import, so /api/health reports a real version', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    expect(PACKAGE_JSON_PATH).toMatch(/package\.json$/)
    expect(PUBLIC_DIR).toMatch(/public$/)
  })
})

describe('resolveAuditTtlMs', () => {
  it('defaults to 30s', () => {
    expect(resolveAuditTtlMs({})).toBe(30_000)
    expect(AUDIT_READER_TTL_MS).toBe(30_000)
  })

  it('honours an explicit override, including 0 — the resolve-per-request mode', () => {
    expect(resolveAuditTtlMs({ SLEEPER_AUDIT_TTL_MS: '1500' })).toBe(1_500)
    expect(resolveAuditTtlMs({ SLEEPER_AUDIT_TTL_MS: '0' })).toBe(0)
  })

  it('falls back to the default rather than to NaN on an unparseable value', () => {
    // Every comparison against NaN is false, so a NaN TTL would be a cache that never hits — the
    // exact defect the cache exists to remove, arrived at silently.
    expect(resolveAuditTtlMs({ SLEEPER_AUDIT_TTL_MS: 'thirty seconds' })).toBe(30_000)
    expect(resolveAuditTtlMs({ SLEEPER_AUDIT_TTL_MS: '-5' })).toBe(30_000)
  })
})

describe('withoutClusterId', () => {
  it('redacts every cluster UUID and leaves the operator-useful prose', () => {
    const text =
      'session pinned to cluster 1f7b6f6e-6a2d-4f1e-9c8b-2a3d4e5f6a7b via the mcp-cluster-id header'
    expect(withoutClusterId(text)).toBe(
      'session pinned to cluster <redacted> via the mcp-cluster-id header',
    )
    expect(withoutClusterId(text)).toMatch(/mcp-cluster-id/)
  })

  it('redacts more than one, and uppercase, so an error message quoting the id cannot leak it', () => {
    const two = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE and 11111111-2222-3333-4444-555555555555'
    expect(withoutClusterId(two)).toBe('<redacted> and <redacted>')
  })

  it('leaves a string with no UUID in it alone', () => {
    expect(withoutClusterId('COCKROACH_MCP_API_KEY is not set')).toBe(
      'COCKROACH_MCP_API_KEY is not set',
    )
  })
})

describe('isCrossSite', () => {
  it('lets through a client that sends no Sec-Fetch-Site at all — curl, and this suite', () => {
    expect(isCrossSite(fakeReq())).toBe(false)
  })

  it('lets through same-origin fetches and address-bar navigations', () => {
    expect(isCrossSite(fakeReq({ headers: { 'sec-fetch-site': 'same-origin' } }))).toBe(false)
    expect(isCrossSite(fakeReq({ headers: { 'sec-fetch-site': 'none' } }))).toBe(false)
  })

  it('rejects cross-site and same-site — a cross-origin form POST is the threat', () => {
    expect(isCrossSite(fakeReq({ headers: { 'sec-fetch-site': 'cross-site' } }))).toBe(true)
    expect(isCrossSite(fakeReq({ headers: { 'sec-fetch-site': 'same-site' } }))).toBe(true)
  })

  it('treats a repeated header (an array) as absent rather than as a value', () => {
    const req = { headers: { 'sec-fetch-site': ['none', 'cross-site'] } } as unknown as IncomingMessage
    expect(isCrossSite(req)).toBe(false)
  })
})

describe('json', () => {
  it('sets content-type and a byte-accurate content-length', () => {
    const { res, rec } = fakeRes()
    json(res, 200, { hello: 'wörld' })
    expect(rec.status).toBe(200)
    expect(rec.headers['content-type']).toBe('application/json')
    expect(rec.headers['content-length']).toBe(Buffer.byteLength('{"hello":"wörld"}'))
    expect(rec.json()).toEqual({ hello: 'wörld' })
  })

  it('merges extra headers, which is how /api/replay answers with Allow', () => {
    const { res, rec } = fakeRes()
    json(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' })
    expect(rec.status).toBe(405)
    expect(rec.headers.allow).toBe('POST')
  })
})

describe('DEFAULT_ROUTE_DEPS', () => {
  it('wires the real collaborators, so a forgotten override fails loudly rather than stubs', () => {
    expect(DEFAULT_ROUTE_DEPS.version).toBe(VERSION)
    expect(DEFAULT_ROUTE_DEPS.auditTtlMs).toBe(AUDIT_READER_TTL_MS)
    expect(typeof DEFAULT_ROUTE_DEPS.query).toBe('function')
    expect(typeof DEFAULT_ROUTE_DEPS.auditReader).toBe('function')
    expect(typeof DEFAULT_ROUTE_DEPS.providerBanner).toBe('function')
  })

  it('reads static files out of public/ — the real demo page, not a stub', () => {
    // Also the one call that proves PUBLIC_DIR is joined correctly; a wrong path here is a demo
    // that 404s its own index.html.
    expect(DEFAULT_ROUTE_DEPS.readStatic('index.html').toString()).toContain('<!doctype html>')
  })

  it('builds a router with no overrides at all', () => {
    // The production construction path. Nothing is dialled until a request arrives, so this is safe.
    const router = createRouter()
    expect(typeof router.handle).toBe('function')
    // Shutdown with no session ever resolved must be a no-op, not a throw on null.
    expect(() => router.shutdown()).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The audit-session cache
// ─────────────────────────────────────────────────────────────────────────────

describe('createAuditSessionCache', () => {
  function makeCache(opts: {
    readers?: StubReader[]
    ttlMs?: number
    rejectFirst?: boolean
    pending?: Promise<SqlReader>
  }): {
    cache: ReturnType<typeof createAuditSessionCache>
    resolved: StubReader[]
    calls: () => number
    readers: StubReader[]
  } {
    const readers = opts.readers ?? [stubReader()]
    const resolved: StubReader[] = []
    let calls = 0
    let rejectNext = opts.rejectFirst ?? false
    const cache = createAuditSessionCache({
      ttlMs: opts.ttlMs ?? 30_000,
      auditReader: async () => {
        const n = calls++
        if (rejectNext) {
          rejectNext = false
          throw new Error('cockroachlabs.cloud unreachable')
        }
        if (opts.pending) return opts.pending
        return readers[Math.min(n, readers.length - 1)]!
      },
      onResolved: (reader) => resolved.push(reader as StubReader),
    })
    return { cache, resolved, calls: () => calls, readers }
  }

  it('resolves once and leases the same session for the whole TTL window', async () => {
    const { cache, calls, resolved, readers } = makeCache({})
    const a = await cache.acquire()
    cache.release(a, false)
    const b = await cache.acquire()
    cache.release(b, false)

    expect(calls()).toBe(1)
    expect(a).toBe(b)
    // `onResolved` fires once per resolution, not once per request — that is what makes an
    // `mcp.fallback` line mean "we fell back", at a known instant.
    expect(resolved).toEqual([readers[0]])
    expect(readers[0]!.closeCalls).toBe(0)
  })

  it('re-resolves once the window has passed, retiring and closing the old session', async () => {
    // ttl 0 is the documented resolve-per-request mode, and the fastest way to exercise expiry
    // without waiting 30s for it.
    const first = stubReader()
    const second = stubReader()
    const { cache, calls } = makeCache({ ttlMs: 0, readers: [first, second] })

    const a = await cache.acquire()
    cache.release(a, false)
    const b = await cache.acquire()
    cache.release(b, false)

    expect(calls()).toBe(2)
    expect(a).not.toBe(b)
    expect(first.closeCalls).toBe(1)
    // The one in force is still open — nothing closed the session it just handed out.
    expect(second.closeCalls).toBe(0)
  })

  it('collapses a burst on a cold cache into ONE dial', async () => {
    // The whole point of `auditResolving`: a page load fires state + explain + a hold read at once,
    // and three simultaneous Streamable HTTP connects to a third party is worse than one.
    const gate = deferred<SqlReader>()
    const { cache, calls } = makeCache({ pending: gate.promise })
    const both = Promise.all([cache.acquire(), cache.acquire()])
    gate.resolve(stubReader())
    const [a, b] = await both

    expect(calls()).toBe(1)
    expect(a).toBe(b)
    expect(a.leases).toBe(2)
  })

  it('caches nothing when the resolution rejects, and recovers on the next attempt', async () => {
    const { cache, calls } = makeCache({ rejectFirst: true })
    await expect(cache.acquire()).rejects.toThrow('cockroachlabs.cloud unreachable')
    expect(cache.current()).toBeNull()

    const session = await cache.acquire()
    expect(calls()).toBe(2)
    expect(session.retired).toBe(false)
    cache.release(session, false)
  })

  it('takes a session out of the cache when a request failed while holding it', async () => {
    // The recovery path: an MCP session the far end has dropped throws from the statement, not from
    // the resolution, so the failing request is the one that has to invalidate it.
    const first = stubReader()
    const second = stubReader()
    const { cache, calls } = makeCache({ readers: [first, second] })

    const a = await cache.acquire()
    cache.release(a, true)
    expect(first.closeCalls).toBe(1)
    expect(cache.current()).toBeNull()

    const b = await cache.acquire()
    expect(calls()).toBe(2)
    expect(b.reader).toBe(second)
    cache.release(b, false)
  })

  it('never closes a session out from under a request that is still holding it', async () => {
    // This is the defect the lease count exists for: a cache that closes on a timer turns into a
    // new class of 500 the first time a close lands mid-statement.
    const reader = stubReader()
    const { cache } = makeCache({ readers: [reader] })
    const a = await cache.acquire()
    const b = await cache.acquire()
    expect(a).toBe(b)

    cache.retire(a) // e.g. SIGTERM arrived
    expect(cache.current()).toBeNull()
    expect(reader.closeCalls).toBe(0) // two leases still out

    cache.release(a, false)
    expect(reader.closeCalls).toBe(0) // one still out
    cache.release(b, false)
    expect(reader.closeCalls).toBe(1) // the last one out closed it
  })

  it('closes a retired session exactly once, however many times it is retired', async () => {
    // `closing` is the guard for this. Both signal handlers point at the same shutdown, and a
    // retire that reached `close()` twice would hand the same MCP session two close calls.
    const reader = stubReader()
    const { cache } = makeCache({ readers: [reader] })
    const session = await cache.acquire()
    cache.release(session, false)

    cache.retire(session)
    cache.retire(session)
    cache.release(session, true) // and the failure path on top
    expect(reader.closeCalls).toBe(1)
  })

  it('retiring a session that is not the current one leaves the current one alone', async () => {
    const first = stubReader()
    const second = stubReader()
    const { cache } = makeCache({ ttlMs: 0, readers: [first, second] })
    const a = await cache.acquire()
    cache.release(a, false)
    const b = await cache.acquire()

    cache.retire(a) // already superseded
    expect(b.retired).toBe(false)
    cache.release(b, false)
    expect(second.closeCalls).toBe(0)
  })

  it('logs — and survives — a close that rejects', async () => {
    // A leaked MCP session is how a long demo run ends up rate-limited, so it is worth a line; it
    // is not worth failing a request that has already been answered.
    const reader = stubReader({ closeRejects: true })
    const { cache } = makeCache({ readers: [reader] })
    const session = await cache.acquire()
    cache.release(session, true)
    await new Promise((r) => setTimeout(r, 0))

    expect(eventsLogged()).toContain('audit.reader_close_failed')
    expect(lines.find((l) => l.event === 'audit.reader_close_failed')!.level).toBe('error')
  })

  it('releases the lease whether the work succeeded or threw', async () => {
    const reader = stubReader()
    const { cache } = makeCache({ readers: [reader] })

    const seen = await cache.with(async ({ reader: r, calls }) => {
      await r.select('SELECT 1')
      return calls()
    })
    expect(seen).toEqual(['SQL SELECT'])
    expect(cache.current()!.leases).toBe(0)

    await expect(
      cache.with(async () => {
        throw new Error('statement failed')
      }),
    ).rejects.toThrow('statement failed')
    // Failed ⇒ retired ⇒ closed, because the session is the suspect.
    expect(cache.current()).toBeNull()
    expect(reader.closeCalls).toBe(1)
  })

  it('slices `calls` from where the request found them, not from the session start', async () => {
    // `tools/list` is pushed at connect and belongs to the session, not to any one request. This is
    // the property that makes `audit.calls` in a response mean "what this request ran".
    const reader = stubReader()
    reader.calls.push('tools/list')
    const { cache } = makeCache({ readers: [reader] })
    const seen = await cache.with(async ({ reader: r, calls }) => {
      await r.explain('SELECT 1')
      return calls()
    })
    expect(seen).toEqual(['SQL EXPLAIN'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Static files
// ─────────────────────────────────────────────────────────────────────────────

describe('static routes', () => {
  it.each([
    ['/', 'text/html; charset=utf-8'],
    ['/index.html', 'text/html; charset=utf-8'],
    ['/app.css', 'text/css; charset=utf-8'],
    ['/app.js', 'text/javascript; charset=utf-8'],
    ['/icon.svg', 'image/svg+xml'],
  ])('serves %s as %s', async (url, type) => {
    const { router } = makeRouter()
    const rec = await request(router, { url })
    expect(rec.status).toBe(200)
    expect(rec.headers['content-type']).toBe(type)
    expect(rec.body).toContain('stub')
  })

  it('defaults a request with no URL to the demo page', async () => {
    // `req.url` is optional on IncomingMessage and Node has been known to hand over an empty one on
    // a malformed request line; '/' is the answer that cannot be wrong.
    const { router } = makeRouter()
    const rec = await request(router, {})
    expect(rec.status).toBe(200)
    expect(rec.headers['content-type']).toBe('text/html; charset=utf-8')
  })

  it('404s a file that is not there, as text, without leaking the path', async () => {
    const { router } = makeRouter({
      readStatic: () => {
        throw new Error("ENOENT: no such file or directory, open '/build/public/app.css'")
      },
    })
    const rec = await request(router, { url: '/app.css' })
    expect(rec.status).toBe(404)
    expect(rec.headers['content-type']).toBe('text/plain')
    expect(rec.body).toBe('not found')
    expect(rec.body).not.toContain('ENOENT')
  })

  it('404s an unknown route as JSON', async () => {
    const { router } = makeRouter()
    const rec = await request(router, { url: '/api/nope' })
    expect(rec.status).toBe(404)
    expect(rec.json()).toEqual({ error: 'not_found' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// /api/health
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/health', () => {
  it('reports 200 with every dependency and the configured MCP mode', async () => {
    const { router } = makeRouter({
      loadThresholds: () => ({
        thresholds: FALLBACK_THRESHOLDS,
        calibrated: { ...FALLBACK_THRESHOLDS, fittedOn: 'x', method: 'y', generatedWith: 'z' },
      }),
    })
    const rec = await request(router, { url: '/api/health' })
    expect(rec.status).toBe(200)
    const b = rec.json()
    expect(b.status).toBe('ok')
    expect(b.db.reachable).toBe(true)
    expect(typeof b.db.latencyMs).toBe('number')
    expect(b.thresholds).toBe('fitted')
    expect(b.inference).toBe('offline')
    expect(b.version).toBe('9.9.9')
    expect(b.mcp).toEqual({ via: 'direct', reason: 'COCKROACH_MCP_API_KEY is not set' })
  })

  it("calls a fallback threshold set 'fallback', not degraded — it is a documented mode", async () => {
    const { router } = makeRouter()
    const b = (await request(router, { url: '/api/health' })).json()
    expect(b.thresholds).toBe('fallback')
    expect(b.status).toBe('ok')
  })

  it("says 'bedrock' when the process is not in offline mode", async () => {
    const { router } = makeRouter({ offline: false })
    expect((await request(router, { url: '/api/health' })).json().inference).toBe('bedrock')
  })

  it('answers 503 when the cluster is unreachable — there is no memory to decide on', async () => {
    const { router } = makeRouter({
      query: async () => {
        throw new Error('connection to server at "sleeper.cockroachlabs.cloud" (34.1.2.3) failed')
      },
    })
    const rec = await request(router, { url: '/api/health' })
    expect(rec.status).toBe(503)
    const b = rec.json()
    expect(b.status).toBe('degraded')
    expect(b.db).toEqual({ reachable: false, latencyMs: null })
    // The pg message names the host, the IP and the SQL user. It goes to the log, never the wire.
    expect(rec.body).not.toContain('cockroachlabs.cloud')
    expect(eventsLogged()).toContain('health.db_unreachable')
  })

  it('answers 503 when thresholds.json is unreadable — the cut points cannot be established', async () => {
    const { router } = makeRouter({
      loadThresholds: () => {
        throw new Error('Unexpected token } in JSON at position 41')
      },
    })
    const rec = await request(router, { url: '/api/health' })
    expect(rec.status).toBe(503)
    expect(rec.json().thresholds).toBe('unreadable')
    expect(eventsLogged()).toContain('health.thresholds_unreadable')
  })

  it('never puts the cluster id in the body of the route an operator exposes on purpose', async () => {
    // This was a real leak: `handleHealth` returned `resolveMcpMode()` verbatim and its reason
    // sentence names the pinned cluster.
    const { router } = makeRouter({
      resolveMcpMode: () => ({
        via: 'mcp',
        endpoint: 'https://cockroachlabs.cloud/mcp',
        clusterPinned: true,
        reason:
          'COCKROACH_MCP_API_KEY set; session pinned to cluster 1f7b6f6e-6a2d-4f1e-9c8b-2a3d4e5f6a7b via the mcp-cluster-id header',
      }),
    })
    const rec = await request(router, { url: '/api/health' })
    expect(rec.body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    const b = rec.json()
    // Redacted, not removed: the operator still learns the session is pinned, and by which header.
    expect(b.mcp.via).toBe('mcp')
    expect(b.mcp.clusterPinned).toBe(true)
    expect(b.mcp.endpoint).toBe('https://cockroachlabs.cloud/mcp')
    expect(b.mcp.reason).toContain('<redacted>')
    expect(b.mcp.reason).toMatch(/mcp-cluster-id/)
  })

  it('does not dial the Managed MCP Server — a monitor must not become a load generator', async () => {
    const { router, resolutions } = makeRouter()
    await request(router, { url: '/api/health' })
    expect(resolutions()).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// /api/state
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/state', () => {
  it('reports the package panel and names the path that served the audit read', async () => {
    const { router } = makeRouter()
    const rec = await request(router, { url: '/api/state' })
    expect(rec.status).toBe(200)
    const b = rec.json()
    expect(b.packageId).toBe(config.packageId)
    expect(b.counts).toEqual({ events: 25, arcs: 3, playbook: 16, heldOut: 4 })
    expect(b.trustStatus).toBe('held')
    expect(b.latestHold).toMatchObject({ id: HOLD_ROW.id, releaseVersion: '5.6.0' })
    expect(b.audit).toEqual({ via: 'direct', reason: 'stub reader — no MCP key in this test' })
    expect(b.dbReachable).toBe(true)
    expect(b.degraded).toBeNull()
    expect(b.offline).toBe(true)
    expect(b.provider).toBe('inference: stub')
  })

  it('reports zeroes and nulls for an empty cluster rather than NaN and undefined', async () => {
    const { router } = makeRouter({
      query: stubQuery({ events: [], arcs: [], playbook: [], holds: [], trust: [] }),
    })
    const b = (await request(router, { url: '/api/state' })).json()
    expect(b.counts).toEqual({ events: 0, arcs: 0, playbook: 0, heldOut: 0 })
    expect(b.trustStatus).toBeNull()
    expect(b.latestHold).toBeNull()
    expect(b.degraded).toBeNull()
  })

  it('counts a playbook with no held-out rows as 0 held out, not as undefined', async () => {
    const { router } = makeRouter({ query: stubQuery({ playbook: [{ held_out: false, n: '16' }] }) })
    const b = (await request(router, { url: '/api/state' })).json()
    expect(b.counts.playbook).toBe(16)
    expect(b.counts.heldOut).toBe(0)
  })

  it('degrades to 200 with a reason when the cluster is unreachable, and never 500s', async () => {
    // It used to throw, which surfaced as a bare 500 and a page that could only say "server
    // unreachable" — the moment the operator most needs the page to explain itself.
    const { router } = makeRouter({
      query: async () => {
        throw new Error('password authentication failed for user "sleeper_agent"')
      },
    })
    const rec = await request(router, { url: '/api/state' })
    expect(rec.status).toBe(200)
    const b = rec.json()
    expect(b.dbReachable).toBe(false)
    expect(b.degraded).toBe('db_unreachable')
    expect(b.counts).toEqual({ events: 0, arcs: 0, playbook: 0, heldOut: 0 })
    expect(rec.body).not.toContain('sleeper_agent')
    expect(eventsLogged()).toContain('state.db_unreachable')
  })

  it('degrades with the thresholds reason and still answers 200', async () => {
    const { router } = makeRouter({
      loadThresholds: () => {
        throw new Error('thresholds.json is truncated')
      },
    })
    const rec = await request(router, { url: '/api/state' })
    expect(rec.status).toBe(200)
    const b = rec.json()
    expect(b.degraded).toBe('thresholds_unreadable')
    expect(b.thresholds).toEqual(FALLBACK_THRESHOLDS) // the panel still has cut points to show
    expect(b.calibrated).toBeNull()
    expect(eventsLogged()).toContain('state.thresholds_unreadable')
  })

  it('keeps the first reason when both dependencies are down', async () => {
    // `degraded ?? 'db_unreachable'`: thresholds is the reason the operator can act on locally.
    const { router } = makeRouter({
      loadThresholds: () => {
        throw new Error('unreadable')
      },
      query: async () => {
        throw new Error('unreachable')
      },
    })
    const b = (await request(router, { url: '/api/state' })).json()
    expect(b.degraded).toBe('thresholds_unreadable')
    expect(b.dbReachable).toBe(false)
  })

  it('redacts the cluster id out of the header field the UI shows', async () => {
    const { router } = makeRouter({
      auditReader: async () =>
        stubReader({
          via: 'mcp',
          reason: 'session pinned to cluster 1f7b6f6e-6a2d-4f1e-9c8b-2a3d4e5f6a7b',
        }),
    })
    const rec = await request(router, { url: '/api/state' })
    // Scoped to `audit`, because `latestHold.id` is also a UUID and is supposed to be there — it is
    // the id a judge pastes into /api/hold/. The cluster identifier is the one that must not appear.
    expect(JSON.stringify(rec.json().audit)).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    )
    expect(rec.json().audit).toEqual({
      via: 'mcp',
      reason: 'session pinned to cluster <redacted>',
    })
  })

  it('resolves the audit path once for repeated requests inside the TTL window', async () => {
    // The fix that let the suite's timeouts come back down: this used to dial cockroachlabs.cloud
    // on every single call, ~0.9s each, on the request a page makes on load.
    const { router, resolutions } = makeRouter()
    await request(router, { url: '/api/state' })
    await request(router, { url: '/api/state' })
    await request(router, { url: '/api/state' })
    expect(resolutions()).toBe(1)
  })

  it('warns on mcp.fallback only when MCP was actually configured', async () => {
    const configured = makeRouter({
      resolveMcpMode: () => ({
        via: 'mcp',
        endpoint: 'https://cockroachlabs.cloud/mcp',
        clusterPinned: false,
        reason: 'key set',
      }),
    })
    await request(configured.router, { url: '/api/state' })
    const warned = lines.find((l) => l.event === 'mcp.fallback')!
    expect(warned.level).toBe('warn')
    expect(warned.configured).toBe(true)
    expect(warned.ttlMs).toBe(30_000)

    lines = []
    const clean = makeRouter()
    await request(clean.router, { url: '/api/state' })
    const noted = lines.find((l) => l.event === 'mcp.fallback')!
    // Info, not warn: on a clean checkout direct SQL is the documented path, and warning about it
    // would train the operator to ignore warnings.
    expect(noted.level).toBe('info')
    expect(noted.configured).toBe(false)
  })

  it('says nothing about a fallback when the MCP path is the one in force', async () => {
    const { router } = makeRouter({ auditReader: async () => stubReader({ via: 'mcp' }) })
    await request(router, { url: '/api/state' })
    expect(eventsLogged()).not.toContain('mcp.fallback')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// /api/replay
// ─────────────────────────────────────────────────────────────────────────────

describe('/api/replay', () => {
  it('refuses GET with 405, an Allow header and a JSON body — nothing is reset', async () => {
    // `runReplay` starts with `resetPackage`, which DELETEs the package's entire memory. As a GET
    // that was deletable by any link prefetcher, mid-recording.
    const { router } = makeRouter({
      runReplay: async () => {
        throw new Error('runReplay must not be called')
      },
    })
    const rec = await request(router, { url: '/api/replay' })
    expect(rec.status).toBe(405)
    expect(rec.headers.allow).toBe('POST')
    expect(rec.headers['content-type']).toBe('application/json')
    expect(rec.json()).toMatchObject({ error: 'method_not_allowed' })
  })

  it.each(['HEAD', 'PUT', 'DELETE'])('refuses %s too', async (method) => {
    const { router } = makeRouter()
    const rec = await request(router, { url: '/api/replay', method })
    expect(rec.status).toBe(405)
  })

  it('rejects a cross-site POST — a form on a page the operator is visiting', async () => {
    const { router } = makeRouter({
      runReplay: async () => {
        throw new Error('runReplay must not be called')
      },
    })
    const rec = await request(router, {
      url: '/api/replay',
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    expect(rec.status).toBe(403)
    expect(rec.json()).toEqual({ error: 'cross_site_forbidden' })
  })

  it('streams start, every step and summary for a same-origin POST', async () => {
    const steps: Step[] = [
      { type: 'log', message: 'resetting' },
      { type: 'match', matches: [] },
    ]
    // Captured rather than asserted in place: an `expect` inside `runReplay` would be caught by
    // `handleReplay` and reported as a `failed` event, i.e. a silently passing test.
    let seen: ReplayOptions | undefined
    const { router } = makeRouter({
      runReplay: async (opts, onStep) => {
        seen = opts
        for (const step of steps) onStep(step)
        return SUMMARY
      },
    })
    const rec = await request(router, {
      url: '/api/replay',
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', host: '127.0.0.1:3000' },
    })

    expect(rec.status).toBe(200)
    expect(rec.headers['content-type']).toBe('text/event-stream')
    expect(rec.events().map((e) => e.event)).toEqual(['start', 'log', 'match', 'summary'])

    expect(seen!.packageId).toBe(TIMELINE.packageId)
    expect(seen!.windowDays).toBe(config.arcWindowDays)
    expect(seen!.maxCandidates).toBe(config.maxCandidates)
    // The demo does not tell the agent whom to suspect.
    expect(seen!.suspectActor).toBe(config.suspectActorOverride)
    expect(seen!.thresholds).toEqual(FALLBACK_THRESHOLDS)
    expect(seen!.events).toEqual(TIMELINE.events)

    const start = rec.events()[0]!.data
    expect(start.total).toBe(1)
    expect(start.calibrated).toBe(false)
    expect(start.offline).toBe(true)
    // The corrId is in the stream so a screenshot of a failed run carries what finds the log lines.
    expect(start.corrId).toMatch(/^[0-9a-f]{8}$/)
    expect(rec.events()[3]!.data.assessedActor).toBe('jia-tan')
    expect(rec.ended).toBe(1)
  })

  it('reports calibrated thresholds as calibrated', async () => {
    const { router } = makeRouter({
      loadThresholds: () => ({
        thresholds: FALLBACK_THRESHOLDS,
        calibrated: { ...FALLBACK_THRESHOLDS, fittedOn: 'x', method: 'y', generatedWith: 'z' },
      }),
    })
    const rec = await request(router, { url: '/api/replay', method: 'POST' })
    expect(rec.events()[0]!.data.calibrated).toBe(true)
  })

  it('answers 409 while a replay is in flight — they all write the same memory', async () => {
    const gate = deferred<ReplaySummary>()
    const { router } = makeRouter({ runReplay: () => gate.promise })

    const first = request(router, { url: '/api/replay', method: 'POST' })
    // The lock is taken synchronously before the first await, so the second request sees it.
    const second = await request(router, { url: '/api/replay', method: 'POST' })
    expect(second.status).toBe(409)
    expect(second.json()).toMatchObject({ error: 'replay_in_flight' })

    gate.resolve(SUMMARY)
    await first

    // And the lock is released, so the next one is served.
    const third = await request(router, { url: '/api/replay', method: 'POST' })
    expect(third.status).toBe(200)
  })

  it('sends a failure as an event, because the stream is already open', async () => {
    const { router } = makeRouter({
      runReplay: async () => {
        throw new Error('embed call failed: ThrottlingException')
      },
    })
    const rec = await request(router, { url: '/api/replay', method: 'POST' })
    expect(rec.status).toBe(200) // the header went out before anything could fail
    const failed = rec.events().find((e) => e.event === 'failed')!
    expect(failed.data.error).toBe('replay_failed')
    expect(failed.data.ref).toMatch(/^[0-9a-f]{8}$/)
    // Same run, same id: the failure event is correlated with the start event the browser already has.
    expect(failed.data.corrId).toBe(rec.events()[0]!.data.corrId)
    // Same rule as everywhere: the detail is in the log, a reference is on the wire.
    expect(JSON.stringify(failed.data)).not.toContain('ThrottlingException')
    expect(eventsLogged()).toContain('replay.failed')
    expect(rec.ended).toBe(1)
  })

  it('reports a corpus that will not load as a failure event, not a broken stream', async () => {
    const { router } = makeRouter({
      loadTimeline: () => {
        throw new Error('data/xz-timeline.json is missing')
      },
    })
    const rec = await request(router, { url: '/api/replay', method: 'POST' })
    expect(rec.events().map((e) => e.event)).toEqual(['failed'])
    expect(rec.ended).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// /api/explain
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/explain', () => {
  it('404s before any replay has run, which is a legitimate state on a fresh cluster', async () => {
    const { router } = makeRouter({ loadActorArc: async () => null })
    const rec = await request(router, { url: '/api/explain' })
    expect(rec.status).toBe(404)
    expect(rec.json()).toMatchObject({ error: 'no_actor_arc' })
  })

  it('explains through the resolved audit reader and names the path that served it', async () => {
    const { router } = makeRouter()
    const rec = await request(router, { url: '/api/explain' })
    expect(rec.status).toBe(200)
    const b = rec.json()
    expect(b.prefixScoped).toBe(true)
    expect(b.usedVectorIndex).toBe(true)
    expect(b.audit.via).toBe('direct')
    // `calls` is the proof it went through the SqlReader surface rather than around it.
    expect(b.audit.calls).toEqual(['SQL EXPLAIN'])
    const logged = lines.find((l) => l.event === 'retrieval.explained')!
    expect(logged.actorId).toBe(config.suspectActor)
    expect(logged.corrId).toMatch(/^[0-9a-f]{8}$/)
    expect(typeof logged.durMs).toBe('number')
  })

  it('falls back to the configured inspection actor until a replay has chosen one', async () => {
    const { router } = makeRouter()
    const b = (await request(router, { url: '/api/explain' })).json()
    expect(b.actorId).toBe(config.suspectActor)
  })

  it("explains the actor the last replay actually assessed, not a configured one", async () => {
    // The agent picks the suspect now, so the arc worth explaining is whichever candidate it landed
    // on — this is the field that would silently keep explaining `jia-tan` if the wiring broke.
    const { router } = makeRouter({
      runReplay: async () => ({ ...SUMMARY, assessedActor: 'quiet-maintainer' }),
    })
    await request(router, { url: '/api/replay', method: 'POST' })
    const b = (await request(router, { url: '/api/explain' })).json()
    expect(b.actorId).toBe('quiet-maintainer')
  })

  it('redacts the cluster id out of the audit reason', async () => {
    const { router } = makeRouter({
      auditReader: async () =>
        stubReader({ via: 'mcp', reason: 'pinned to 1f7b6f6e-6a2d-4f1e-9c8b-2a3d4e5f6a7b' }),
    })
    const rec = await request(router, { url: '/api/explain' })
    expect(rec.body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    expect(rec.json().audit.reason).toBe('pinned to <redacted>')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// /api/hold/:id
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/hold/:id', () => {
  it('returns the evidence and names the audit path', async () => {
    const { router } = makeRouter()
    const rec = await request(router, { url: `/api/hold/${HOLD_ROW.id}` })
    expect(rec.status).toBe(200)
    const b = rec.json()
    expect(b.hold.id).toBe(HOLD_ROW.id)
    expect(b.audit).toEqual({
      via: 'direct',
      reason: 'stub reader — no MCP key in this test',
      calls: ['SQL SELECT'],
    })
    const logged = lines.find((l) => l.event === 'audit.read')!
    expect(logged).toMatchObject({ holdId: HOLD_ROW.id, via: 'direct', calls: 1, auditTrailRows: 1 })
  })

  it('404s a well-formed hold id that does not exist', async () => {
    // "you sent nonsense" and "that hold is not here" are different answers.
    const { router } = makeRouter({ holdEvidence: async () => null })
    const rec = await request(router, { url: '/api/hold/00000000-0000-0000-0000-000000000000' })
    expect(rec.status).toBe(404)
    expect(rec.json()).toMatchObject({ error: 'no_such_hold' })
  })

  it('400s a malformed id, as a caller mistake, with nothing of the error on the wire', async () => {
    // This used to be a 500 with a stack: a page-worthy server fault reported for something no
    // server-side change can fix, inflating exactly the rate a monitor alerts on.
    const { router } = makeRouter()
    const rec = await request(router, { url: '/api/hold/not-a-uuid' })
    expect(rec.status).toBe(400)
    const b = rec.json()
    expect(b).toMatchObject({ error: 'invalid_hold_id' })
    expect(b.corrId).toMatch(/^[0-9a-f]{8}$/)
    // `assertUuid` echoes the caller's input back inside its message — log only.
    expect(rec.body).not.toMatch(/uuid|assert|not-a-uuid/i)

    const warned = lines.find((l) => l.event === 'hold.invalid_id')!
    // warn, not error: nothing here is broken.
    expect(warned.level).toBe('warn')
    expect(warned.reason).toBe('not_a_uuid')
    expect(warned.route).toBe('/api/hold/not-a-uuid')
  })

  it('400s a truncated percent-escape, which raises URIError before any SQL', async () => {
    const { router } = makeRouter({
      holdEvidence: async () => {
        throw new Error('holdEvidence must not be reached')
      },
    })
    const rec = await request(router, { url: '/api/hold/%E0%A4%A' })
    expect(rec.status).toBe(400)
    expect(rec.json()).toMatchObject({ error: 'invalid_hold_id' })
    expect(lines.find((l) => l.event === 'hold.invalid_id')!.reason).toBe('malformed_escape')
  })

  it('percent-decodes a legitimately escaped id', async () => {
    const { router } = makeRouter()
    const encoded = HOLD_ROW.id.replace(/-/g, '%2D')
    const rec = await request(router, { url: `/api/hold/${encoded}` })
    expect(rec.status).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The catch-all
// ─────────────────────────────────────────────────────────────────────────────

describe('the catch-all', () => {
  it('answers 500 with a reference and never the error message', async () => {
    const { router } = makeRouter({
      holdEvidence: async () => {
        throw new Error(
          'connection to server at "sleeper-cluster.gcp-europe-west1.cockroachlabs.cloud" (34.1.2.3), port 26257 failed: FATAL: password authentication failed for user "sleeper_agent"',
        )
      },
    })
    const rec = await request(router, { url: `/api/hold/${HOLD_ROW.id}` })
    expect(rec.status).toBe(500)
    const b = rec.json()
    expect(b.error).toBe('internal_error')
    expect(b.ref).toMatch(/^[0-9a-f]{8}$/)
    expect(b.corrId).toMatch(/^[0-9a-f]{8}$/)
    expect(rec.body).not.toMatch(/cockroachlabs\.cloud|26257|sleeper_agent|password/i)

    // The whole thing — message and stack — is in the log, under the ref the caller can quote.
    const failure = lines.find((l) => l.event === 'request.failed')!
    expect(failure.ref).toBe(b.ref)
    expect(failure.route).toBe(`/api/hold/${HOLD_ROW.id}`)
    expect(failure.method).toBe('GET')
    expect(String(failure.message)).toContain('sleeper_agent')
  })

  it('does not write a 500 body over headers that already went out', async () => {
    // A client that disappears between the header and the body makes `res.end` throw. The response
    // is already committed at that point, so all that is left to do is close it.
    const { router } = makeRouter()
    const { res, rec } = fakeRes({ endThrowsOnce: true })
    await router.handle(fakeReq({ url: `/api/hold/${HOLD_ROW.id}` }), res)
    expect(rec.status).toBe(200) // not overwritten with 500
    expect(rec.body).toBe('') // the throw ate the payload; nothing new was written
    expect(rec.ended).toBe(2) // and the catch-all closed it
    expect(eventsLogged()).toContain('request.failed')
  })

  it('invalidates the shared session when a request fails while holding it', async () => {
    let fail = true
    const { router, resolutions } = makeRouter({
      holdEvidence: async () => {
        if (fail) throw new Error('MCP session not found')
        return EVIDENCE
      },
    })
    expect((await request(router, { url: `/api/hold/${HOLD_ROW.id}` })).status).toBe(500)
    fail = false
    // Inside the same TTL window, and it still re-resolves: the session was the suspect.
    expect((await request(router, { url: `/api/hold/${HOLD_ROW.id}` })).status).toBe(200)
    expect(resolutions()).toBe(2)
  })

  it('500s when the audit path itself cannot be resolved, and recovers afterwards', async () => {
    let broken = true
    const reader = stubReader()
    const { router } = makeRouter({
      auditReader: async () => {
        if (broken) throw new Error('cockroachlabs.cloud unreachable')
        return reader
      },
    })
    expect((await request(router, { url: '/api/explain' })).status).toBe(500)
    broken = false
    expect((await request(router, { url: '/api/explain' })).status).toBe(200)
  })

  it('logs one http.request line per request, with the status it ended on', async () => {
    const { router } = makeRouter()
    await request(router, { url: '/api/hold/not-a-uuid', method: 'GET', headers: { host: 'demo.local' } })
    const http = lines.filter((l) => l.event === 'http.request')
    expect(http).toHaveLength(1)
    expect(http[0]).toMatchObject({ method: 'GET', route: '/api/hold/not-a-uuid', status: 400 })
    expect(typeof http[0]!.durMs).toBe('number')
    // Every line of this request shares one id, which is what makes the trail greppable.
    const corrIds = new Set(lines.map((l) => l.corrId))
    expect(corrIds.size).toBe(1)
  })

  it('defaults a request with no method to GET', async () => {
    const { router } = makeRouter()
    await request(router, { url: '/api/replay' })
    expect(lines.find((l) => l.event === 'http.request')!.method).toBe('GET')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Shutdown
// ─────────────────────────────────────────────────────────────────────────────

describe('router shutdown', () => {
  it('lets go of the cached reader', async () => {
    const { router, reader } = makeRouter()
    await request(router, { url: '/api/state' })
    expect(reader.closeCalls).toBe(0)

    router.shutdown()
    await new Promise((r) => setTimeout(r, 0))
    expect(reader.closeCalls).toBe(1)
  })

  it('does not close a session out from under an in-flight audit read', async () => {
    // `server.close` is already waiting for that request; losing its session on the way out would
    // turn a clean shutdown into a 500.
    const gate = deferred<HoldEvidence | null>()
    let gated = false
    const { router, reader } = makeRouter({
      holdEvidence: () => (gated ? gate.promise : Promise.resolve(EVIDENCE)),
    })
    // Warm the cache first, deliberately: `shutdown` retires whatever session is currently on offer,
    // and on a cold cache there is not one yet.
    await request(router, { url: `/api/hold/${HOLD_ROW.id}` })
    gated = true
    const inFlight = request(router, { url: `/api/hold/${HOLD_ROW.id}` })
    await new Promise((r) => setTimeout(r, 0)) // let the request take its lease

    router.shutdown()
    await new Promise((r) => setTimeout(r, 0))
    expect(reader.closeCalls).toBe(0)

    gate.resolve(EVIDENCE)
    expect((await inFlight).status).toBe(200)
    await new Promise((r) => setTimeout(r, 0))
    expect(reader.closeCalls).toBe(1)
  })

  it('is a no-op when nothing was ever resolved', () => {
    const { router, reader } = makeRouter()
    expect(() => router.shutdown()).not.toThrow()
    expect(reader.closeCalls).toBe(0)
  })
})
