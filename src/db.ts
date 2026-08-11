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
    async tableSchema(table: string): Promise<string> {
      calls.push('SQL SHOW CREATE TABLE')
      // Identifier, not a value — validated rather than quoted, because a table name cannot be
      // bound as a parameter and must never be concatenated unchecked.
      if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error(`Not a plain table name: ${table}`)
      const result = await query<{ create_statement: string }>(`SHOW CREATE TABLE ${table}`)
      return result.rows.map((r) => r.create_statement).join('\n')
    },
    async close(): Promise<void> {
      // The pool is shared with the write path and closed by the process, not by one reader.
    },
  }
}

/** Runs `fn` inside a single transaction — used for the atomic HOLD. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
