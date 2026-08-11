/**
 * HTTP surface and Lambda-handler tests.
 *
 * The server is started as a real child process against a real cluster rather than by importing
 * `src/server.ts` — that module starts listening as a side effect of import, so there is no way to
 * exercise it in-process without either refactoring the demo entry point into a factory or leaking
 * a listener into the test runner. Booting it is also what actually proves the two things this file
 * is here for: that `/api/replay` really is unreachable by GET, and that the process really does
 * bind loopback only.
 *
 * Skipped without DATABASE_URL, like tests/integration.test.ts, so a clean checkout stays green.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createLogger, setLogSink, type LogLine } from '../src/log.js'
import { closePool, query } from '../src/db.js'

const LIVE = Boolean(process.env.DATABASE_URL)

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

    it('never returns a raw error message on a failing route', async () => {
      // A malformed hold id makes `assertUuid` throw deep inside the audit read.
      const res = await fetch(`${BASE}/api/hold/not-a-uuid`)
      expect(res.status).toBe(500)
      const b = await readJson(res)
      expect(b).toMatchObject({ error: 'internal_error' })
      expect(b.ref).toMatch(/^[0-9a-f]{8}$/)
      // The thing that must not be there: any prose from the underlying error.
      expect(JSON.stringify(b)).not.toMatch(/uuid|assert|postgres|sslmode|26257/i)
    })
  })

  describe('C9 — the browser demo exercises the resolved audit reader', () => {
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
  }, 30_000)
})
