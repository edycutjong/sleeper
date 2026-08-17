import type { PoolClient } from 'pg'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { closePool, directSqlReader, getPool, query, withTransaction } from '../src/db.js'
import { config } from '../src/config.js'
import { LIVE } from './live.js'

/**
 * tests/unit.test.ts already exercises the pure, no-cluster surface of src/db.ts: `isRetryable`,
 * `toVector`/`fromVector`, `showCreateTableSql`'s validation, and the retry loop against a fake
 * `PoolClient`. This file covers what that suite cannot reach without a real cluster — the pool
 * itself, the two functions that dial it (`query`, `directSqlReader`'s real-SQL paths), and the
 * retry-loop edges the fake-client suite's fixtures never trigger (a non-Error thrown value, a
 * degenerate `maxAttempts`, the actual `setTimeout`-backed backoff).
 *
 * The real-cluster suites below are read-only (SELECT 1 / EXPLAIN / SHOW CREATE TABLE) or run a
 * transaction that never writes, so there is no data to namespace or tear down — only the pool
 * itself, in `afterAll`. They are gated on `LIVE` (see tests/live.ts) so a checkout with no
 * reachable CockroachDB still runs the rest of the suite green, exactly like tests/integration.ts.
 */

describe.skipIf(!LIVE)('getPool / closePool — the shared connection pool', () => {
  afterAll(async () => {
    await closePool()
  })

  it('builds a Pool wired with the CockroachDB Cloud specific options', () => {
    const pool = getPool()
    expect(pool.options.connectionString).toBe(config.databaseUrl())
    expect(pool.options.max).toBe(8)
    expect(pool.options.idleTimeoutMillis).toBe(30_000)
    // The value that stops a node stuck mid-handshake (Cloud draining, a rolling upgrade) from
    // hanging the caller forever instead of failing — see the comment in src/db.ts.
    expect(pool.options.connectionTimeoutMillis).toBe(10_000)
  })

  it('memoizes — repeat calls hand back the identical pool rather than opening a second one', () => {
    expect(getPool()).toBe(getPool())
  })

  it('swallows an idle-client error instead of letting an unhandled EventEmitter error kill the process', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pool = getPool()
    // This is exactly what node-postgres emits when an IDLE client's socket dies underneath it —
    // the scenario the comment above `pool.on('error', ...)` in src/db.ts describes. No real
    // socket is involved; what's under test is that OUR listener runs and does not rethrow.
    pool.emit('error', new Error('read ECONNRESET'))
    expect(warn).toHaveBeenCalledTimes(1)
    const [message] = warn.mock.calls[0]!
    expect(message).toContain('idle client error')
    expect(message).toContain('read ECONNRESET')
    warn.mockRestore()
  })

  it('closePool ends the pool, and the next getPool builds a fresh one rather than reusing the ended one', async () => {
    const before = getPool()
    await closePool()
    const after = getPool()
    expect(after).not.toBe(before)
  })

  it('query() runs a real statement against the pool', async () => {
    const result = await query<{ one: number }>('SELECT 1::INT4 AS one')
    expect(result.rows).toEqual([{ one: 1 }])
  })
})

describe.skipIf(!LIVE)('directSqlReader — the real-SQL backing of the audit read surface', () => {
  afterAll(async () => {
    await closePool()
  })

  it('select() runs the statement, returns rows, and records the call', async () => {
    const reader = directSqlReader('coverage — real cluster select')
    const rows = await reader.select<{ one: number }>('SELECT 1::INT4 AS one')
    expect(rows).toEqual([{ one: 1 }])
    expect(reader.calls).toEqual(['SQL SELECT'])
  })

  it('explain() wraps the statement in EXPLAIN and returns non-empty plan text', async () => {
    const reader = directSqlReader('coverage — real cluster explain')
    const plan = await reader.explain('SELECT 1')
    expect(plan.length).toBeGreaterThan(0)
    expect(reader.calls).toEqual(['SQL EXPLAIN'])
  })

  it('tableSchema() with no database returns the unqualified CREATE TABLE text', async () => {
    const reader = directSqlReader('coverage — real cluster schema, unqualified')
    const schema = await reader.tableSchema('events')
    expect(schema).toContain('CREATE TABLE')
    expect(schema).toContain('events')
    expect(reader.calls).toEqual(['SQL SHOW CREATE TABLE'])
  })

  it('tableSchema() with a database qualifies through the public schema, same shape the MCP path names', async () => {
    // config.databaseName() derives from DATABASE_URL, which this suite requires to be set — see
    // tests/live.ts. Asserting it is non-null keeps this test honest about that precondition
    // instead of silently passing `undefined` through and exercising the unqualified branch again.
    const database = config.databaseName()
    expect(database).not.toBeNull()
    const reader = directSqlReader('coverage — real cluster schema, qualified')
    const schema = await reader.tableSchema('events', database!)
    expect(schema).toContain('CREATE TABLE')
    expect(schema).toContain('events')
  })

  it('close() is a no-op that resolves — the pool belongs to the process, not to one reader', async () => {
    const reader = directSqlReader('coverage — close is a no-op')
    await expect(reader.close()).resolves.toBeUndefined()
  })
})

describe.skipIf(!LIVE)('withTransaction — default connect() dials the real pool', () => {
  afterAll(async () => {
    await closePool()
  })

  it('with no connect option, uses getPool().connect() and commits a real (read-only) transaction', async () => {
    const result = await withTransaction(async (client) => {
      const r = await client.query<{ one: number }>('SELECT 1::INT4 AS one')
      return r.rows[0]!.one
    })
    expect(result).toBe(1)
  })
})

describe('withTransaction — edges the fake-client suite in tests/unit.test.ts does not reach', () => {
  it('works from pure defaults (only connect injected) — baseDelayMs default is assigned but never slept on', async () => {
    let begins = 0
    const client = {
      async query(sql: string) {
        if (sql === 'BEGIN') begins++
        return { rows: [], rowCount: 0 }
      },
      release() {},
    } as unknown as PoolClient
    // baseDelayMs is intentionally omitted, exercising `options.baseDelayMs ?? 50` picking its
    // default. The default is never actually slept on here because the body succeeds first try —
    // proving the default assignment doesn't itself force an unwanted delay.
    const result = await withTransaction(async () => 'ok', { connect: async () => client })
    expect(result).toBe('ok')
    expect(begins).toBe(1)
  })

  it('backs off with a real timer before a retry, for the exact ms the doubling+jitter formula computes', async () => {
    const log: string[] = []
    let commits = 0
    const client = {
      async query(sql: string) {
        log.push(sql)
        if (sql === 'COMMIT' && commits++ === 0) {
          throw Object.assign(new Error('restart transaction'), { code: '40001' })
        }
        return { rows: [], rowCount: 0 }
      },
      release() {},
    } as unknown as PoolClient

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout')
    try {
      await withTransaction(async () => 'ok', { connect: async () => client, baseDelayMs: 20 })
      // attempt 1: 20 * 2**0 * (0.5 + 0.5) = 20 exactly. A baseDelayMs:0 test (in unit.test.ts)
      // takes `sleep`'s `ms <= 0` short-circuit and never reaches `setTimeout` at all — this proves
      // the OTHER side of that branch, that a positive delay really arms a real timer.
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 20)
      expect(log.filter((s) => s === 'BEGIN')).toHaveLength(2)
    } finally {
      randomSpy.mockRestore()
      setTimeoutSpy.mockRestore()
    }
  })

  it('destroys the client with a synthesized Error when the thrown value is not an Error and ROLLBACK also fails', async () => {
    const released: unknown[] = []
    const client = {
      async query(sql: string) {
        if (sql === 'ROLLBACK') throw new Error('connection already gone')
        return { rows: [], rowCount: 0 }
      },
      release(err?: unknown) {
        released.push(err)
      },
    } as unknown as PoolClient

    await expect(
      withTransaction(
        async () => {
          // A raw thrown value — e.g. a string surfacing from hand-rolled validation rather than a
          // real Error — is exactly the case `lastError instanceof Error` guards against.
          throw 'a raw string, not an Error instance'
        },
        { connect: async () => client, baseDelayMs: 0 },
      ),
    ).rejects.toBe('a raw string, not an Error instance')

    expect(released).toHaveLength(1)
    // Destroyed (release(err)) with a synthesized Error, because client.release expects
    // `Error | undefined` and the real thrown value was neither an Error nor undefined.
    expect(released[0]).toBeInstanceOf(Error)
    expect((released[0] as Error).message).toBe('rollback failed')
  })

  it('rejects with the untouched initial lastError when maxAttempts never lets the loop run at all', async () => {
    let connected = 0
    const connect = async (): Promise<PoolClient> => {
      connected++
      throw new Error('should never be called')
    }
    // maxAttempts: 0 is a degenerate config nobody should pass — TransactionOptions does not
    // forbid it, though, so this pins the actual behaviour rather than guessing: the loop's own
    // condition (`attempt <= maxAttempts`) is false before the first iteration, `lastError` is
    // still its initial `undefined`, and that is what the promise rejects with — not a helpful
    // "maxAttempts must be >= 1" error, because nothing in this function validates its input.
    await expect(
      withTransaction(async () => 'never', { connect, maxAttempts: 0 }),
    ).rejects.toBeUndefined()
    expect(connected).toBe(0)
  })
})
