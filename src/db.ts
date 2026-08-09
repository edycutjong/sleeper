import pg from 'pg'
import { config } from './config.js'

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

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as never[])
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
