/**
 * Is there a cluster to test against?
 *
 * `Boolean(process.env.DATABASE_URL)` is the wrong question. It tests whether someone typed a
 * connection string, not whether anything answers on the other end — so a stale credential, an
 * expired trial cluster or a typo in the host produced a red suite and a `pg` stack trace out of
 * whatever `beforeAll` happened to touch the pool first. That is a miserable first impression for
 * anyone evaluating this repo, and it is indistinguishable from "your tests are broken".
 *
 * So the gate is reachability, established once, before any suite is collected. Three outcomes:
 *
 *   no DATABASE_URL     -> skip quietly. This is the expected clean-checkout path: `npm test`
 *                          runs the unit suite anywhere, with no database and no AWS account.
 *   set but unreachable -> skip LOUDLY, naming the host and the driver's own error, because this
 *                          one is almost always a fixable mistake and silence would hide it.
 *   reachable           -> run everything.
 *
 * The probe uses its own short-lived client rather than the shared pool in `src/db.ts`: the pool
 * is lazily constructed and long-lived, and a failed connection attempt on it would leave the
 * module-level singleton in a state the real tests then inherit.
 */
import { Client } from 'pg'

/** Long enough for a cold cloud cluster to answer, short enough not to stall `npm test`. */
const PROBE_TIMEOUT_MS = Number(process.env.SLEEPER_PROBE_TIMEOUT_MS ?? 5000)

const url = process.env.DATABASE_URL

/** Host and port only — a connection string carries a password. */
function safeTarget(connectionString: string): string {
  try {
    const u = new URL(connectionString)
    return `${u.hostname}:${u.port || '26257'}${u.pathname}`
  } catch {
    return '(unparseable DATABASE_URL)'
  }
}

async function probe(): Promise<boolean> {
  if (!url) return false

  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: PROBE_TIMEOUT_MS,
    query_timeout: PROBE_TIMEOUT_MS,
  })

  try {
    await client.connect()
    await client.query('SELECT 1')
    return true
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.warn(
      `\n  ⚠ Integration tests SKIPPED — DATABASE_URL is set but ${safeTarget(url)} did not answer.` +
        `\n    ${detail}` +
        `\n    Nothing is wrong with the code; there is nowhere to run it. To get a cluster:` +
        `\n      cockroach start-single-node --insecure --listen-addr=localhost:26257 --store=/tmp/sleeper-crdb` +
        `\n      cockroach sql --insecure -e 'CREATE DATABASE sleeper'` +
        `\n      export DATABASE_URL='postgresql://root@localhost:26257/sleeper?sslmode=disable' SLEEPER_OFFLINE=1` +
        `\n      npm run schema && npm test\n`,
    )
    return false
  } finally {
    // A failed connect() leaves nothing to end(), and end() on it rejects. Either way we are done
    // with this client, and the probe's own cleanup must never be what fails the run.
    await client.end().catch(() => {})
  }
}

/**
 * Resolved once, at module load, via top-level await — `describe.skipIf()` needs a plain boolean at
 * collection time, and every suite importing this shares the single probe rather than each opening
 * its own connection.
 */
export const LIVE: boolean = await probe()
