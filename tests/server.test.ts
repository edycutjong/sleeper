/**
 * The boot, the Lambda handler, and the two properties only a real listener can establish.
 *
 * The routes themselves are no longer here. They live in src/routes.ts behind `createRouter` and
 * are unit-tested in tests/routes.test.ts with a fake `req`/`res` — the change that earned that was
 * to src/, not to a test: `src/server.ts` used to be 800 lines of route logic in a module that
 * started listening as a side effect of import, so the only way to exercise any of it was through a
 * socket, and v8 cannot instrument a child process. Everything that could be a function call is one
 * now.
 *
 * What stayed, because nothing else can establish it:
 *
 *   - **GET /api/replay is unreachable.** A unit test can assert that the dispatcher answers 405,
 *     and tests/routes.test.ts does. Only a real listener can show that a GET arriving over TCP
 *     reaches that dispatcher rather than some earlier layer that answered it first, and that what
 *     comes back is a JSON body rather than an event stream — i.e. that nothing was reset.
 *   - **The process binds loopback only.** That is a property of `listen`, an address and a kernel.
 *     There is no in-process assertion of it; you have to try to connect from somewhere else.
 *
 * Both are asserted against a child process started exactly the way `npm start` starts it, which
 * also covers the entry-point guard at the bottom of src/server.ts and the real boot path through
 * it. The bootstrap's own logic — bind host, banner, the corpus/model check, shutdown — is a set of
 * exported functions, tested in process at the bottom of this file.
 *
 * The child-process describes are skipped without DATABASE_URL, like tests/integration.test.ts, so
 * a clean checkout stays green. The in-process ones need no cluster and always run.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { createLogger, setLogSink, type LogLine } from '../src/log.js'
import { closePool, query } from '../src/db.js'
import { LIVE as liveCluster } from './live.js'
import {
  boot,
  bootBannerLines,
  checkPlaybookModel,
  isEntryPoint,
  productionBootDeps,
  resolveBindHost,
  type BootDeps,
} from '../src/server.js'
import { VERSION } from '../src/routes.js'
import { config } from '../src/config.js'
import { assertPlaybookModel } from '../src/memory.js'

// Reachability, not just presence — see tests/live.ts for why the distinction matters.
const LIVE = liveCluster

// A port of its own so this never collides with a demo server the developer left running.
const PORT = 3400 + (process.pid % 200)
const BASE = `http://127.0.0.1:${PORT}`

let server: ChildProcess | undefined

/** `res.json()` is `unknown`; these bodies are our own server's, asserted field by field. */
async function readJson(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>
}

async function waitForHealth(deadlineMs = 30_000): Promise<void> {
  const until = Date.now() + deadlineMs
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      if (res.status === 200 || res.status === 503) return
    } catch {
      // Not listening yet.
    }
    if (Date.now() > until) throw new Error('server did not come up')
    await new Promise((r) => setTimeout(r, 200))
  }
}

describe.skipIf(!LIVE)('demo server', () => {
  beforeAll(async () => {
    server = spawn('npx', ['tsx', 'src/server.ts'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, PORT: String(PORT), SLEEPER_OFFLINE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForHealth()
    /**
     * Health answering is not the same as ready, now that the audit path is resolved lazily and
     * cached: the FIRST request to a route that needs it still dials cockroachlabs.cloud once, and
     * whichever test happened to be first would pay ~1s of it inside a 5s budget — the same coin
     * flip that made C9 flaky, just relocated. Warming it here puts that one cold call inside the
     * 60s setup budget where it belongs, and leaves every test measuring the warm path, which is the
     * path the fix is about. It cannot mask a regression: if the resolution went back to being per
     * request, every call after this one would be slow again and the median assertion below fails.
     */
    await fetch(`${BASE}/api/state`).catch(() => {
      // A cluster that cannot answer /api/state is what the degradation tests are for, not a setup
      // failure — they assert the response, and this call exists only for its side effect.
    })
  }, 60_000)

  afterAll(async () => {
    if (server && !server.killed) {
      server.kill('SIGTERM')
      await Promise.race([once(server, 'exit'), new Promise((r) => setTimeout(r, 3_000))])
      if (!server.exitCode && !server.signalCode) server.kill('SIGKILL')
    }
  })

  describe('C1 — the destructive route is POST-only and loopback-bound', () => {
    it('refuses GET /api/replay with 405 and an Allow header', async () => {
      const res = await fetch(`${BASE}/api/replay`)
      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toBe('POST')
      // Critically: the body is JSON, not an event stream — nothing was reset.
      expect(res.headers.get('content-type')).toContain('application/json')
      expect(await readJson(res)).toMatchObject({ error: 'method_not_allowed' })
    })

    it('refuses HEAD too — a prefetcher that HEADs a link must not reset the demo', async () => {
      const res = await fetch(`${BASE}/api/replay`, { method: 'HEAD' })
      expect(res.status).toBe(405)
    })

    it('rejects a cross-site POST', async () => {
      const res = await fetch(`${BASE}/api/replay`, {
        method: 'POST',
        headers: { 'sec-fetch-site': 'cross-site' },
      })
      expect(res.status).toBe(403)
      expect(await readJson(res)).toMatchObject({ error: 'cross_site_forbidden' })
    })

    it('does not listen on a non-loopback interface', async () => {
      // The server was started without SLEEPER_BIND_HOST, so it must be on 127.0.0.1 only. Proving
      // "nothing else can reach it" needs a second address; the machine's own hostname is the one
      // that is always available, and a connection there must be refused.
      const { networkInterfaces } = await import('node:os')
      const external = Object.values(networkInterfaces())
        .flat()
        .find((i) => i && i.family === 'IPv4' && !i.internal)
      if (!external) return // CI with no external interface — nothing to prove against.

      await expect(
        fetch(`http://${external.address}:${PORT}/api/health`, {
          signal: AbortSignal.timeout(2_000),
        }),
      ).rejects.toThrow()
    })
  })

  describe('C3 — health', () => {
    it('reports every dependency and the resolved MCP mode', async () => {
      const res = await fetch(`${BASE}/api/health`)
      expect(res.status).toBe(200)
      const b = await readJson(res)

      expect(b.status).toBe('ok')
      expect(b.db.reachable).toBe(true)
      expect(typeof b.db.latencyMs).toBe('number')
      expect(b.inference).toBe('offline') // the child was started with SLEEPER_OFFLINE=1
      expect(['fitted', 'fallback']).toContain(b.thresholds)
      expect(b.version).toMatch(/^\d+\.\d+\.\d+$/)
      // The whole resolved mode, not just a boolean — `reason` is what tells an operator why.
      expect(['mcp', 'direct']).toContain(b.mcp.via)
      expect(typeof b.mcp.reason).toBe('string')
    })

    it('does not disclose the cluster id to an unauthenticated caller', async () => {
      // `handleHealth` returned `resolveMcpMode()` verbatim, and its reason sentence names the
      // pinned cluster — so the full CockroachDB Cloud cluster id was in the body of the one route
      // an operator deliberately exposes to a monitor. Loopback by default keeps the severity low;
      // SLEEPER_BIND_HOST is a documented override, which is why "low" is not "fine".
      const res = await fetch(`${BASE}/api/health`)
      const b = await readJson(res)
      expect(JSON.stringify(b)).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      )
      // Redacted, not removed: an operator still learns the session is pinned, and by which header.
      if (b.mcp.via === 'mcp') {
        expect(typeof b.mcp.clusterPinned).toBe('boolean')
        if (b.mcp.clusterPinned) expect(b.mcp.reason).toMatch(/mcp-cluster-id/)
      }
      // Same string reaches /api/state's header field, so it gets the same treatment.
      const state = await readJson(await fetch(`${BASE}/api/state`))
      expect(JSON.stringify(state.audit)).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      )
    })
  })

  /**
   * The reason the raised timeout above could come back down to 5s.
   *
   * `/api/state` resolved the audit reader per request, and with COCKROACH_MCP_API_KEY set that
   * resolution opens a Streamable HTTP session to cockroachlabs.cloud and reads `tools/list` before
   * it can answer: measured 0.90–1.06s per call against `/api/health`'s 0.0015s. A page load's
   * latency was a third-party round trip, and the suite had already started timing out on it.
   *
   * Asserted on the MEDIAN of several warm calls rather than on each one, deliberately. The thing
   * being pinned down is a ~0.9s structural cost that every single call paid, which a median catches
   * outright; a per-call bound would instead be a bet that a shared single-node cluster never has a
   * slow moment, i.e. the flaky-timeout mistake this test exists because of. Cached, these measure
   * ~0.002s, so the bound below has ~250x of headroom while still failing the defect by 2x.
   */
  describe('the audit path is resolved once per TTL window, not once per request', () => {
    const WARM_CALLS = 5
    const MEDIAN_BUDGET_MS = 500

    it('serves repeated /api/state without paying for a third-party dial each time', async () => {
      // One unmeasured call so the measurement is of the warm path. Whether the resolution happened
      // here or in an earlier test does not matter — either way it is not in the samples below.
      await fetch(`${BASE}/api/state`)

      const samples: number[] = []
      for (let i = 0; i < WARM_CALLS; i++) {
        const started = performance.now()
        const res = await fetch(`${BASE}/api/state`)
        expect(res.status).toBe(200)
        await res.json()
        samples.push(performance.now() - started)
      }

      const median = [...samples].sort((a, b) => a - b)[Math.floor(WARM_CALLS / 2)]!
      expect(median, `warm /api/state samples (ms): ${samples.map((s) => s.toFixed(1)).join(', ')}`)
        .toBeLessThan(MEDIAN_BUDGET_MS)
    })

    it('still reports which path actually served the read', async () => {
      // The cache must not be allowed to buy its speed by going vague. Two properties:
      // `via`/`reason` are still there and populated, and — the one a stale cache would break —
      // they cannot claim MCP when MCP was never configured in this process at all.
      const health = await readJson(await fetch(`${BASE}/api/health`))
      const first = await readJson(await fetch(`${BASE}/api/state`))
      const second = await readJson(await fetch(`${BASE}/api/state`))

      for (const b of [first, second]) {
        expect(['mcp', 'direct']).toContain(b.audit.via)
        expect(b.audit.reason.length).toBeGreaterThan(0)
      }
      // Two reads inside one TTL window must not disagree about the path in force.
      expect(second.audit.via).toBe(first.audit.via)
      // Configured direct ⇒ resolved direct. (The converse does not hold: MCP can be configured and
      // still fall back, which is exactly what `audit.reason` is for.)
      if (health.mcp.via === 'direct') expect(first.audit.via).toBe('direct')
    })
  })

  describe('C2 / C3 — /api/state degrades instead of throwing, and leaks nothing', () => {
    it('answers 200 with the audit path named', async () => {
      const res = await fetch(`${BASE}/api/state`)
      expect(res.status).toBe(200)
      const b = await readJson(res)
      expect(b.dbReachable).toBe(true)
      expect(b.degraded).toBeNull()
      expect(['mcp', 'direct']).toContain(b.audit.via)
      expect(b.audit.reason.length).toBeGreaterThan(0)
    })

    it('rejects a malformed hold id with 400, and never returns a raw error message', async () => {
      // This used to be a 500: `assertUuid` threw deep inside the audit read and landed in the
      // catch-all, reporting a caller-fixable mistake as a server fault.
      const res = await fetch(`${BASE}/api/hold/not-a-uuid`)
      expect(res.status).toBe(400)
      const b = await readJson(res)
      expect(b).toMatchObject({ error: 'invalid_hold_id' })
      expect(b.corrId).toMatch(/^[0-9a-f]{8}$/)
      // The thing that must not be there: any prose from the underlying error. `assertUuid` echoes
      // the caller's own input back inside its message, and that message stays in the log.
      expect(JSON.stringify(b)).not.toMatch(/uuid|assert|postgres|sslmode|26257/i)
    })

    it('rejects a malformed percent-escape in the hold id with 400 too', async () => {
      // `decodeURIComponent` raises URIError on a truncated escape — same class of caller mistake,
      // and it reached the same catch-all.
      const res = await fetch(`${BASE}/api/hold/%E0%A4%A`)
      expect(res.status).toBe(400)
      const b = await readJson(res)
      expect(b).toMatchObject({ error: 'invalid_hold_id' })
      expect(JSON.stringify(b)).not.toMatch(/uuid|assert|postgres|sslmode|26257/i)
    })

    it('still answers 404 for a well-formed hold id that does not exist', async () => {
      // The 400 above must not have swallowed the absent case: "you sent nonsense" and "that hold
      // is not here" are different answers.
      const res = await fetch(`${BASE}/api/hold/00000000-0000-0000-0000-000000000000`)
      expect(res.status).toBe(404)
      expect(await readJson(res)).toMatchObject({ error: 'no_such_hold' })
    })
  })

  describe('C9 — the browser demo exercises the resolved audit reader', () => {
    // Back on vitest's 5s default. This carried `{ timeout: 20_000 }` because the route resolved the
    // audit reader per request, which with COCKROACH_MCP_API_KEY set meant dialling
    // cockroachlabs.cloud inside the request — ~0.85s of it idle, and past 5s under suite load. The
    // resolution is cached now (AUDIT_READER_TTL_MS in src/server.ts), so what is left inside the
    // request is the `explain_query` tool call itself, measured at ~0.7s: that one is the feature,
    // not overhead, and it cannot be cached without the evidence ceasing to come from the cluster.
    it('names the path that served the explain read', async () => {
      const res = await fetch(`${BASE}/api/explain`)
      // 404 before a replay has ever run, which is a legitimate state on a fresh cluster.
      if (res.status === 404) {
        expect(await readJson(res)).toMatchObject({ error: 'no_actor_arc' })
        return
      }
      expect(res.status).toBe(200)
      const b = await readJson(res)
      expect(['mcp', 'direct']).toContain(b.audit.via)
      // `calls` is the proof it went through the SqlReader surface rather than around it.
      expect(b.audit.calls.length).toBeGreaterThan(0)
      expect(typeof b.prefixScoped).toBe('boolean')
    })
  })
})

/**
 * C6c — one deployment, many packages.
 *
 * `parseEvent` used to hardcode `config.packageId` while parsing every other field from the body,
 * so a Lambda could only ever write into one package's memory no matter what the webhook said.
 */
describe.skipIf(!LIVE)('ingestHandler package routing (C6)', () => {
  const A = `test-handler-a-${process.pid}`
  const B = `test-handler-b-${process.pid}`

  afterAll(async () => {
    for (const pkg of [A, B]) await query('DELETE FROM events WHERE package_id = $1', [pkg])
    await closePool()
  })

  async function post(body: Record<string, unknown>): Promise<{ statusCode: number; body: any }> {
    // Imported lazily: the module reads config at import time and this file also drives a server.
    const { ingestHandler } = await import('../src/handler.js')
    const res = await ingestHandler({ body: JSON.stringify(body) })
    return { statusCode: res.statusCode, body: JSON.parse(res.body) }
  }

  it('routes two package_id payloads into two separate memories', async () => {
    const base = {
      actor_id: 'multi-tenant-actor',
      kind: 'commit',
      occurred_at: '2024-01-01T00:00:00Z',
    }
    const first = await post({ ...base, package_id: A, content: 'fix in package A' })
    const second = await post({ ...base, package_id: B, content: 'fix in package B' })
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)

    const inA = await query<{ content: string }>('SELECT content FROM events WHERE package_id = $1', [A])
    const inB = await query<{ content: string }>('SELECT content FROM events WHERE package_id = $1', [B])
    expect(inA.rows.map((r) => r.content)).toEqual(['fix in package A'])
    expect(inB.rows.map((r) => r.content)).toEqual(['fix in package B'])
  })

  it('rejects over-length content with a structured 400 rather than storing it', async () => {
    const { MAX_CONTENT_CHARS } = await import('../src/handler.js')
    const res = await post({
      package_id: A,
      actor_id: 'multi-tenant-actor',
      kind: 'commit',
      occurred_at: '2024-01-01T00:00:00Z',
      content: 'x'.repeat(MAX_CONTENT_CHARS + 1),
    })
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toBe('field_too_long')

    const stored = await query<{ n: string }>(
      'SELECT count(*) AS n FROM events WHERE package_id = $1',
      [A],
    )
    expect(Number(stored.rows[0]!.n)).toBe(1) // still just the one from the previous test
  })

  it('returns a structured 400 for a missing field, not an unhandled throw', async () => {
    const res = await post({ package_id: A, actor_id: 'x', kind: 'commit' })
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toBe('missing_fields')
    expect(res.body.corrId).toMatch(/^[0-9a-f]{8}$/)
  })
})

/**
 * C4 — the allow path leaves a record.
 *
 * The audit trail is written inside `commitHold`, so before this there was no evidence anywhere
 * that the gate had assessed a release and let it through. A false negative that leaves no trace is
 * the failure mode a release gate cannot have, so `decision.made` is asserted for BOTH outcomes.
 */
describe('structured logging (C4)', () => {
  it('emits a JSON line carrying the correlation id and the fields an operator needs', () => {
    const lines: LogLine[] = []
    const restore = setLogSink((line) => lines.push(line))
    try {
      createLogger({ corrId: 'abc12345', packageId: 'xz-utils' }).info('decision.made', {
        outcome: 'allow',
        similarity: 0.41,
      })
    } finally {
      setLogSink(restore)
    }
    expect(lines[0]).toMatchObject({
      level: 'info',
      event: 'decision.made',
      corrId: 'abc12345',
      packageId: 'xz-utils',
      outcome: 'allow',
    })
    expect(Date.parse(String(lines[0]!.ts))).not.toBeNaN()
  })
})

describe.skipIf(!LIVE)('decision logging covers allow as well as hold (C4)', () => {
  const PKG = `test-log-${process.pid}`

  afterAll(async () => {
    const { resetPackage } = await import('../src/memory.js')
    await resetPackage(PKG)
    await closePool()
  })

  async function runOnce(): Promise<LogLine[]> {
    const { runReplay } = await import('../src/agent.js')
    const { FALLBACK_THRESHOLDS } = await import('../src/decide.js')
    const lines: LogLine[] = []
    const restore = setLogSink((line) => lines.push(line))
    try {
      await runReplay(
        {
          packageId: PKG,
          suspectActor: 'quiet-actor',
          windowDays: 90,
          thresholds: FALLBACK_THRESHOLDS,
          events: [
            {
              packageId: PKG,
              actorId: 'quiet-actor',
              kind: 'commit',
              content: 'small portability fix to the decoder',
              occurredAt: '2023-01-01T00:00:00Z',
            },
            {
              packageId: PKG,
              actorId: 'quiet-actor',
              kind: 'release',
              content: 'publishes the 1.2.3 release tarball',
              occurredAt: '2023-02-01T00:00:00Z',
            },
          ],
          corrId: 'testcorr',
        },
        () => {},
      )
    } finally {
      setLogSink(restore)
    }
    return lines
  }

  it('records ingest, arc, retrieval and an ALLOW decision, all under one corrId', async () => {
    const lines = await runOnce()
    const events = lines.map((l) => l.event)

    expect(events).toContain('ingest.written')
    expect(events).toContain('arc.built')
    expect(events).toContain('retrieval.explained')
    expect(events).toContain('decision.made')

    const decision = lines.find((l) => l.event === 'decision.made')!
    // The whole point: an allow is logged, with the numbers and the thresholds that produced it.
    expect(decision.outcome).toBe('allow')
    expect(typeof decision.similarity).toBe('number')
    expect(typeof decision.margin).toBe('number')
    expect(typeof decision.holdAt).toBe('number')
    expect(typeof decision.minMargin).toBe('number')
    expect(decision.corrId).toBe('testcorr')

    // No hold happened, so there must be no hold line — the allow line is the only record.
    expect(events).not.toContain('hold.committed')

    // Every line is correlated, which is what makes the trail greppable.
    expect(lines.every((l) => l.corrId === 'testcorr')).toBe(true)
    expect(lines.find((l) => l.event === 'retrieval.explained')).toHaveProperty('prefixScoped')
    // 30s stays, and it is not the audit-reader problem in disguise: this suite is gated on LIVE
    // alone, so with SLEEPER_OFFLINE unset `runReplay` makes real Bedrock embed and Converse calls
    // and 5s is not a budget it can meet. Offline — how CI and the Makefile run it — it finishes in
    // well under 300ms, so the allowance costs nothing when it is not needed.
  }, 30_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// The bootstrap, in process.
//
// src/server.ts is importable without booting: the only statement with a side effect is the
// entry-point guard at the bottom, which is true exactly when the module IS `process.argv[1]`. So
// everything the boot decides can be called directly here, while the boot itself is still performed
// for real by the child process above.
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveBindHost', () => {
  it('binds loopback when nothing says otherwise', () => {
    // `server.listen(port)` bound every interface, which on conference wifi puts an unauthenticated
    // route that wipes the demo's memory on the local network.
    expect(resolveBindHost({})).toBe('127.0.0.1')
  })

  it('honours SLEEPER_BIND_HOST, because a container has to bind 0.0.0.0 to be reachable', () => {
    expect(resolveBindHost({ SLEEPER_BIND_HOST: '0.0.0.0' })).toBe('0.0.0.0')
  })
})

describe('bootBannerLines', () => {
  const base = { host: '127.0.0.1', port: 3000, offline: false, provider: 'inference: stub' }

  it('names the URL and the inference path — this is what a judge sees in the recording', () => {
    expect(bootBannerLines(base)).toEqual(['Sleeper demo on http://127.0.0.1:3000', 'inference: stub'])
  })

  it('says so out loud when the run is offline', () => {
    expect(bootBannerLines({ ...base, offline: true })).toContain(
      'OFFLINE MODE — deterministic stand-in for Bedrock. Wiring only, no quality claims.',
    )
  })

  it('warns when the bind is not loopback, naming what that exposes', () => {
    const lines = bootBannerLines({ ...base, host: '0.0.0.0' })
    const warning = lines.find((l) => l.startsWith('WARNING'))!
    expect(warning).toContain('bound to 0.0.0.0, not loopback')
    expect(warning).toContain('/api/replay resets this package')
    expect(warning).toContain('no authentication')
  })

  it('does not warn for either spelling of loopback', () => {
    for (const host of ['127.0.0.1', 'localhost']) {
      expect(bootBannerLines({ ...base, host }).some((l) => l.startsWith('WARNING'))).toBe(false)
    }
  })
})

describe('checkPlaybookModel', () => {
  function capture(): { lines: LogLine[]; restore: () => void } {
    const lines: LogLine[] = []
    const previous = setLogSink((line) => lines.push(line))
    return { lines, restore: () => setLogSink(previous) }
  }

  it('passes silently when the corpus agrees with the configured model', async () => {
    const { lines, restore } = capture()
    try {
      await expect(checkPlaybookModel(async () => {})).resolves.toBeUndefined()
      expect(lines).toEqual([])
    } finally {
      restore()
    }
  })

  it('refuses the boot on an embedding model mismatch', async () => {
    // The thrown message is a complete operator instruction, and a boot that dies printing it is
    // worth more than a server that comes up unable to decide — which is what this used to do,
    // reporting health `ok` right up until a release was assessed, mid-recording.
    const err = new Error('embedding model mismatch: corpus embedded with titan-v1, process uses v2')
    await expect(
      checkPlaybookModel(async () => {
        throw err
      }),
    ).rejects.toThrow(err)
  })

  it('boots anyway when the check could not be made at all', async () => {
    // A cluster that could not answer is not a check that said no. `/api/health` reports that as
    // 503 and `/api/state` degrades for it, and neither can report anything from a process that
    // refused to listen.
    const { lines, restore } = capture()
    try {
      await expect(
        checkPlaybookModel(async () => {
          throw new Error('relation "takeover_playbook" does not exist')
        }),
      ).resolves.toBeUndefined()
      expect(lines.map((l) => l.event)).toEqual(['startup.playbook_model_uncheckable'])
    } finally {
      restore()
    }
  })

  it('treats a non-Error throw as uncheckable rather than as a mismatch', async () => {
    // The discrimination is on `.message`, so anything without one cannot be the fatal case.
    const { lines, restore } = capture()
    try {
      await expect(
        checkPlaybookModel(async () => {
          throw 'pool destroyed'
        }),
      ).resolves.toBeUndefined()
      expect(lines.map((l) => l.event)).toEqual(['startup.playbook_model_uncheckable'])
    } finally {
      restore()
    }
  })
})

describe('isEntryPoint', () => {
  const selfUrl = new URL('../src/server.ts', import.meta.url).href

  it('says yes when the module is what the process was started with', () => {
    expect(isEntryPoint(selfUrl, fileURLToPath(selfUrl))).toBe(true)
  })

  it('says yes for a relative argv[1], which is how `tsx src/server.ts` arrives', () => {
    expect(isEntryPoint(selfUrl, 'src/../src/server.ts')).toBe(true)
  })

  it('says no when something else is the entry point', () => {
    expect(isEntryPoint(selfUrl, fileURLToPath(new URL('../src/routes.ts', import.meta.url)))).toBe(
      false,
    )
  })

  it('says no when there is no argv[1] at all', () => {
    expect(isEntryPoint(selfUrl, undefined)).toBe(false)
  })

  it('says no rather than throwing when a path cannot be resolved', () => {
    // Nothing was started, so nothing is broken by saying no.
    expect(isEntryPoint(selfUrl, '/definitely/not/here/server.ts')).toBe(false)
    expect(isEntryPoint('not-a-file-url', process.argv[1])).toBe(false)
  })

  it('is false under this test runner, which is why importing src/server.ts does not boot', () => {
    expect(isEntryPoint(selfUrl, process.argv[1])).toBe(false)
  })
})

describe('productionBootDeps', () => {
  it('names the real collaborators and reads the real configuration', () => {
    const deps = productionBootDeps()
    expect(deps.port).toBe(config.port)
    expect(deps.host).toBe(resolveBindHost(process.env))
    expect(deps.version).toBe(VERSION)
    expect(typeof deps.offline).toBe('boolean')
    expect(deps.assertPlaybookModel).toBe(assertPlaybookModel)
    // Referenced, not wrapped: an arrow here would be one more thing that can be wrong.
    expect(deps.exit).toBe(process.exit)
    expect(deps.log).toBe(console.log)
    expect(typeof deps.router.handle).toBe('function')
    expect(typeof deps.providerBanner()).toBe('string')
  })

  it('registers the handler on the process, which is the one thing a test must not inherit', () => {
    const deps = productionBootDeps()
    const handler = (): void => {}
    // SIGUSR2 rather than SIGTERM: this asserts the registration, and the runner keeps its own.
    deps.onSignal('SIGUSR2', handler)
    try {
      expect(process.listeners('SIGUSR2')).toContain(handler)
    } finally {
      process.off('SIGUSR2', handler)
    }
  })
})

describe('boot', () => {
  /** A router that answers everything, so this describe is about the boot and not about routing. */
  function stubRouter(): { router: BootDeps['router']; shutdowns: () => number } {
    let shutdowns = 0
    return {
      router: {
        handle: async (_req, res) => {
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end('ok')
        },
        shutdown: () => {
          shutdowns++
        },
      },
      shutdowns: () => shutdowns,
    }
  }

  function harness(overrides: Partial<BootDeps> = {}): {
    deps: BootDeps
    logged: string[]
    signals: [NodeJS.Signals, () => void][]
    exits: number[]
    pools: () => number
    shutdowns: () => number
  } {
    const { router, shutdowns } = stubRouter()
    const logged: string[] = []
    const signals: [NodeJS.Signals, () => void][] = []
    const exits: number[] = []
    let pools = 0
    const deps: BootDeps = {
      router,
      host: '127.0.0.1',
      // Port 0: an ephemeral port, so this never collides with a demo server or with the child
      // process above. The banner reports `deps.port`, so it says 0 — asserted against
      // `bootBannerLines` rather than against a hardcoded string.
      port: 0,
      offline: true,
      providerBanner: () => 'inference: stub',
      version: '9.9.9',
      assertPlaybookModel: async () => {},
      closePool: async () => {
        pools++
      },
      log: (line) => logged.push(line),
      exit: (code) => exits.push(code),
      onSignal: (signal, handler) => signals.push([signal, handler]),
      ...overrides,
    }
    return { deps, logged, signals, exits, pools: () => pools, shutdowns }
  }

  it('listens, prints the banner, logs server.listening and serves through the router', async () => {
    const { deps, logged, signals } = harness()
    const lines: LogLine[] = []
    const previous = setLogSink((line) => lines.push(line))
    let booted
    try {
      booted = await boot(deps)
    } finally {
      setLogSink(previous)
    }

    const { port } = booted.server.address() as AddressInfo
    expect(port).toBeGreaterThan(0)
    const res = await fetch(`http://127.0.0.1:${port}/api/state`)
    expect(await res.text()).toBe('ok')

    expect(logged).toEqual(
      bootBannerLines({ host: '127.0.0.1', port: 0, offline: true, provider: 'inference: stub' }),
    )
    expect(lines.find((l) => l.event === 'server.listening')).toMatchObject({
      host: '127.0.0.1',
      version: '9.9.9',
      inference: 'offline',
    })
    // Both signals, pointed at the same shutdown.
    expect(signals.map(([s]) => s)).toEqual(['SIGINT', 'SIGTERM'])
    expect(signals[0]![1]).toBe(signals[1]![1])

    booted.shutdown()
    await vi.waitFor(() => expect(booted!.server.listening).toBe(false))
  })

  it("reports inference 'bedrock' when the process is not offline", async () => {
    const { deps } = harness({ offline: false })
    const lines: LogLine[] = []
    const previous = setLogSink((line) => lines.push(line))
    let booted
    try {
      booted = await boot(deps)
    } finally {
      setLogSink(previous)
    }
    expect(lines.find((l) => l.event === 'server.listening')!.inference).toBe('bedrock')
    booted.shutdown()
    await vi.waitFor(() => expect(booted!.server.listening).toBe(false))
  })

  it('lets go of the audit session, closes the pool and exits — in that order', async () => {
    // The cached reader outlives a request, so shutdown is the one place that has to let go of it,
    // and `server.close` waits for the in-flight request before the pool goes.
    const { deps, exits, pools, shutdowns } = harness()
    const previous = setLogSink(() => {})
    let booted
    try {
      booted = await boot(deps)
    } finally {
      setLogSink(previous)
    }

    booted.shutdown()
    expect(shutdowns()).toBe(1) // the router is retired synchronously, before the socket closes
    await vi.waitFor(() => expect(exits).toEqual([0]))
    expect(pools()).toBe(1)
    expect(booted.server.listening).toBe(false)
  })

  it('refuses to listen at all on an embedding model mismatch', async () => {
    const { deps, signals, logged } = harness({
      assertPlaybookModel: async () => {
        throw new Error('embedding model mismatch: re-seed, or point the process back at titan-v1')
      },
    })
    await expect(boot(deps)).rejects.toThrow(/embedding model mismatch/)
    // Nothing was created, so there is nothing to clean up and no banner claiming a live server.
    expect(signals).toEqual([])
    expect(logged).toEqual([])
  })
})
