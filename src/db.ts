import pg from 'pg'
import { config } from './config.js'
import type { SqlReader } from './mcp.js'

const { Pool } = pg

let pool: pg.Pool | null = null

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl(),
      // CockroachDB Cloud terminates idle connections; keep the pool small and short-lived
      // so a demo run that sits idle between events doesn't fail on a stale socket.
      max: 8,
      idleTimeoutMillis: 30_000,
      // Without this, a cluster that accepts the TCP connection but never completes the handshake
      // (Cloud node draining, a rolling upgrade) hangs the caller forever rather than failing.
      connectionTimeoutMillis: 10_000,
    })

    // node-postgres emits 'error' on an IDLE client whose socket dies — which is exactly what the
    // comment above describes happening. An 'error' event with no listener is an unhandled
    // EventEmitter error, and Node's response to that is to terminate the process. Losing the
    // agent because a connection it was not using went away would be an absurd way to fail, so the
    // event is logged and swallowed: pg has already removed the dead client from the pool, and the
    // next checkout dials a fresh one.
    pool.on('error', (err) => {
      console.warn(`[db] idle client error (pool recovered, connection discarded): ${err.message}`)
    })
  }
  return pool
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}

/**
 * pg has no native binding for CockroachDB's VECTOR type, so vectors cross the wire as the
 * pgvector text literal `[1,2,3]` and are cast with `::VECTOR` at the call site.
 */
export function toVector(embedding: number[]): string {
  if (embedding.length !== config.aws.embeddingDimensions) {
    throw new Error(
      `Embedding has ${embedding.length} dimensions, expected ${config.aws.embeddingDimensions}. ` +
        `Check BEDROCK_EMBEDDING_MODEL_ID and the dimensions requested from Titan.`,
    )
  }
  return `[${embedding.join(',')}]`
}

/** Inverse of `toVector` — CockroachDB returns VECTOR columns as the same text literal. */
export function fromVector(literal: string): number[] {
  return literal
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map(Number)
}

/** Plain, unquoted, ASCII SQL identifiers — the only shape this file is willing to interpolate. */
const PLAIN_IDENTIFIER = /^[a-z_][a-z0-9_]*$/i

/**
 * `SHOW CREATE TABLE`, optionally qualified by database — the statement behind `tableSchema`.
 *
 * The `database` argument is not cosmetic. The MCP session is pinned to a CLUSTER by the
 * `mcp-cluster-id` header and has no session database of its own, so `CockroachMcpClient`
 * (src/mcp.ts) is handed one explicitly and `scripts/mcp-audit.ts` passes `config.databaseName()`.
 * The direct-SQL reader is already inside whatever database DATABASE_URL names, so it used to
 * ignore the argument entirely — which meant the two paths this project claims are equivalent
 * could describe two different databases, silently, with nothing in the output saying so.
 *
 * Both parts are IDENTIFIERS, not values. They cannot be bound as parameters, and they must never
 * go through `sqlLiteral`: `SHOW CREATE TABLE 'sleeper'.public.events` is a syntax error, not a
 * safer query. Validation is the substitute for quoting, so the database name gets exactly the
 * same regex the table name already got rather than a weaker check or none.
 *
 * Exported so both forms are assertable without a cluster.
 */
export function showCreateTableSql(table: string, database?: string): string {
  if (!PLAIN_IDENTIFIER.test(table)) throw new Error(`Not a plain table name: ${table}`)
  if (database != null && !PLAIN_IDENTIFIER.test(database)) {
    throw new Error(`Not a plain database name: ${database}`)
  }
  // `public` is spelled out because a bare `db.table` is ambiguous in CockroachDB's
  // three-part naming and resolves against the search path rather than to the public schema.
  return database == null
    ? `SHOW CREATE TABLE ${table}`
    : `SHOW CREATE TABLE ${database}.public.${table}`
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as never[])
}

/**
 * The direct-SQL backing of the audit read surface (see `SqlReader` in src/mcp.ts).
 *
 * This is the fallback the audit path lands on when the Managed MCP Server is not configured or
 * cannot be reached. It answers the identical statements the MCP tools are handed, so the two
 * paths cannot drift: `select_query` → `query`, `explain_query` → `EXPLAIN <sql>`,
 * `get_table_schema` → `SHOW CREATE TABLE`.
 *
 * `reason` is mandatory and printed by every caller, so choosing this path is always visible.
 */
export function directSqlReader(reason: string): SqlReader {
  const calls: string[] = []
  return {
    via: 'direct',
    reason,
    calls,
    async select<T = Record<string, unknown>>(sql: string): Promise<T[]> {
      calls.push('SQL SELECT')
      const result = await query(sql)
      return result.rows as T[]
    },
    async explain(sql: string): Promise<string> {
      calls.push('SQL EXPLAIN')
      const result = await query<{ info: string }>(`EXPLAIN ${sql}`)
      return result.rows.map((r) => r.info).join('\n')
    },
    async tableSchema(table: string, database?: string): Promise<string> {
      // Built (and validated) before anything is recorded: a rejected identifier never ran, so
      // listing it in `calls` would put a statement in the audit report that never reached the
      // cluster.
      const sql = showCreateTableSql(table, database)
      calls.push('SQL SHOW CREATE TABLE')
      const result = await query<{ create_statement: string }>(sql)
      return result.rows.map((r) => r.create_statement).join('\n')
    },
    async close(): Promise<void> {
      // The pool is shared with the write path and closed by the process, not by one reader.
    },
  }
}

/**
 * SQLSTATE 40001 — `RETRY_SERIALIZABLE`. CockroachDB runs SERIALIZABLE by default and has no
 * lock-wait fallback: when two transactions genuinely conflict it aborts one and tells the client
 * to run it again. That is not an error condition, it is the documented contract, and a client
 * that does not implement the retry half of it simply loses transactions under concurrency.
 */
export const RETRY_SERIALIZABLE = '40001'

/** True for the one error class CockroachDB expects the client to re-run rather than surface. */
export function isRetryable(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === RETRY_SERIALIZABLE
  )
}

export type TransactionOptions = {
  /** How to obtain a client. Defaults to the shared pool; injectable so the retry is unit-testable. */
  connect?: () => Promise<pg.PoolClient>
  maxAttempts?: number
  /** First backoff step in ms; doubles per attempt with jitter. Set to 0 in tests. */
  baseDelayMs?: number
}

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Runs `fn` inside a single transaction — used for the atomic HOLD — with the client-side retry
 * CockroachDB requires.
 *
 * Why the retry matters here specifically: the HOLD is four writes in one COMMIT, and the two
 * things most likely to run at the same time in this system are a live webhook delivery and a
 * replay of the same package. Both touch `trust_state` for that package. Without a retry, one of
 * them gets a 40001, the exception escapes, and the release is NOT held — the exact outcome the
 * whole project exists to prevent, produced by the database working as designed.
 *
 * `fn` must therefore be idempotent-on-replay: it is called again from scratch on a retry, and
 * everything it wrote in the aborted attempt is gone.
 *
 * Failure handling is deliberately careful in two places:
 *  - ROLLBACK is wrapped, because if the connection is what broke then the ROLLBACK throws too and
 *    an unguarded one REPLACES the real error with a meaningless "connection terminated".
 *  - a client whose rollback failed is destroyed via `release(err)` rather than returned to the
 *    pool. Handing back a connection with an open, aborted transaction poisons whoever checks it
 *    out next, and they get an error about a statement they never ran.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const connect = options.connect ?? (() => getPool().connect())
  const maxAttempts = options.maxAttempts ?? 3
  const baseDelayMs = options.baseDelayMs ?? 50

  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = await connect()
    let rolledBackCleanly = true
    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      lastError = err
      try {
        await client.query('ROLLBACK')
      } catch {
        rolledBackCleanly = false
      }
      if (!isRetryable(err) || attempt === maxAttempts) throw err
    } finally {
      // `release(err)` destroys the connection instead of returning it to the pool.
      if (rolledBackCleanly) client.release()
      else client.release(lastError instanceof Error ? lastError : new Error('rollback failed'))
    }
    // Exponential backoff with full jitter: a fixed backoff makes two conflicting transactions
    // collide again in lockstep, which is how a retry loop turns one conflict into a livelock.
    await sleep(baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random()))
  }
  throw lastError
}
