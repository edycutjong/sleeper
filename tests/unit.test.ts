import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { offlineEmbed } from '../src/embeddings.js'
import {
  directSqlReader,
  fromVector,
  isRetryable,
  showCreateTableSql,
  toVector,
  withTransaction,
} from '../src/db.js'
import {
  ACTOR_HISTORY_SQL,
  MalformedRowError,
  PACKAGE_HISTORY_SQL,
  PLAYBOOK_MATCH_SQL,
  arcWindow,
  eventKey,
  hasPrefixSpans,
  holdEvidence,
  type IngestInput,
} from '../src/memory.js'
import { parseRows, type SqlReader } from '../src/mcp.js'
import { extractVersion } from '../src/agent.js'
import { loadSynthetic, loadTimeline } from '../src/corpus.js'

describe('offlineEmbed', () => {
  it('produces the configured dimensionality', () => {
    expect(offlineEmbed('anything')).toHaveLength(1024)
  })

  it('is deterministic — the same text always gives the same vector', () => {
    expect(offlineEmbed('a slow trust acquisition arc')).toEqual(
      offlineEmbed('a slow trust acquisition arc'),
    )
  })

  it('is L2-normalised, so a dot product is a cosine similarity', () => {
    const v = offlineEmbed('maintainer hands over release signing authority')
    expect(Math.hypot(...v)).toBeCloseTo(1, 10)
  })

  it('survives empty input instead of emitting NaNs', () => {
    const v = offlineEmbed('')
    expect(v.every(Number.isFinite)).toBe(true)
    expect(Math.hypot(...v)).toBeCloseTo(1, 10)
  })

  it('scores related text above unrelated text', () => {
    const dot = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * b[i]!, 0)
    const probe = offlineEmbed('the maintainer handed over release signing authority')
    const related = offlineEmbed('release signing authority was handed to the new maintainer')
    const unrelated = offlineEmbed('the parser was rewritten to reduce allocations')
    expect(dot(probe, related)).toBeGreaterThan(dot(probe, unrelated))
  })
})

describe('vector wire format', () => {
  it('round-trips through the pgvector text literal', () => {
    const original = Array.from({ length: 1024 }, (_, i) => (i % 7) / 7)
    expect(fromVector(toVector(original))).toEqual(original)
  })

  it('rejects a vector of the wrong width rather than letting the INSERT fail opaquely', () => {
    expect(() => toVector([1, 2, 3])).toThrow(/expected 1024/)
  })
})

describe('hasPrefixSpans', () => {
  it('detects the real CockroachDB plan line', () => {
    expect(
      hasPrefixSpans(
        `• vector search\n  table: events@events_pkg_embedding_idx\n  prefix spans: [/'xz-utils' - /'xz-utils']`,
      ),
    ).toBe(true)
  })

  it('is false for an unscoped vector search', () => {
    expect(hasPrefixSpans('• vector search\n  table: takeover_playbook@idx\n  target count: 5')).toBe(
      false,
    )
  })

  it('is false for a full table scan', () => {
    expect(hasPrefixSpans('• scan\n  table: events@events_pkey\n  spans: FULL SCAN')).toBe(false)
  })
})

describe('eventKey — webhook deliveries are at-least-once', () => {
  const base: IngestInput = {
    packageId: 'xz-utils',
    actorId: 'jia-tan',
    kind: 'maintainer_change',
    content: 'named as co-maintainer with commit access',
    occurredAt: '2022-08-01T00:00:00Z',
  }

  it('is stable for the same event', () => {
    expect(eventKey(base)).toBe(eventKey({ ...base }))
  })

  it('collapses two encodings of the same instant, because two delivery paths format differently', () => {
    expect(eventKey({ ...base, occurredAt: '2022-08-01T00:00:00.000+00:00' })).toBe(eventKey(base))
  })

  it('ignores source_url — one commit cited two ways is still one commit', () => {
    expect(eventKey({ ...base, sourceUrl: 'https://example.invalid/a' })).toBe(eventKey(base))
  })

  it('separates events that differ in any identifying field', () => {
    const keys = new Set([
      eventKey(base),
      eventKey({ ...base, packageId: 'other' }),
      eventKey({ ...base, actorId: 'other' }),
      eventKey({ ...base, kind: 'commit' }),
      eventKey({ ...base, content: `${base.content}.` }),
      eventKey({ ...base, occurredAt: '2022-08-02T00:00:00Z' }),
    ])
    expect(keys.size).toBe(6)
  })

  it('cannot be forged by moving a field boundary', () => {
    // A separator-joined key would hash 'a|b' and 'a|' + 'b' identically. JSON encoding cannot.
    expect(eventKey({ ...base, actorId: 'a', content: 'b|c' })).not.toBe(
      eventKey({ ...base, actorId: 'a|b', content: 'c' }),
    )
  })

  it('hashes an unparseable timestamp verbatim rather than throwing — validation is elsewhere', () => {
    expect(eventKey({ ...base, occurredAt: 'not a date' })).toHaveLength(64)
  })
})

describe('the queries that must stay bounded', () => {
  it('both history reads carry a LIMIT and keep the newest rows', () => {
    for (const sql of [ACTOR_HISTORY_SQL, PACKAGE_HISTORY_SQL]) {
      expect(sql).toMatch(/ORDER BY occurred_at DESC\s+LIMIT \$\d/)
      // …and hand them back in ascending order, which is what the arc prompt is built from.
      expect(sql.trimEnd().endsWith('ORDER BY occurred_at ASC')).toBe(true)
    }
  })

  it('scopes the deciding query on held_out inside the query, not after it', () => {
    expect(PLAYBOOK_MATCH_SQL).toContain('held_out = false')
    expect(PLAYBOOK_MATCH_SQL).toContain('embedding_model = $4')
  })
})

describe('withTransaction — CockroachDB requires the client to retry', () => {
  /** A PoolClient just real enough to drive the retry loop, with no cluster involved. */
  function fakeClient(failCommits: number, log: string[]) {
    let commits = 0
    let released = 0
    const client = {
      async query(sql: string) {
        log.push(sql)
        if (sql === 'COMMIT' && commits++ < failCommits) {
          // Shape of a real pg error for SQLSTATE 40001 / RETRY_SERIALIZABLE.
          throw Object.assign(new Error('restart transaction: TransactionRetryWithProtoRefreshError'), {
            code: '40001',
          })
        }
        return { rows: [], rowCount: 0 }
      },
      release(err?: Error | boolean) {
        released++
        log.push(err ? 'RELEASE(destroy)' : 'RELEASE')
      },
      get releaseCount() {
        return released
      },
    }
    return client as unknown as PoolClient & { releaseCount: number }
  }

  it('recognises only SQLSTATE 40001 as retryable', () => {
    expect(isRetryable({ code: '40001' })).toBe(true)
    expect(isRetryable({ code: '23505' })).toBe(false)
    expect(isRetryable(new Error('boom'))).toBe(false)
    expect(isRetryable(null)).toBe(false)
  })

  it('re-runs the body after a 40001 on COMMIT and succeeds', async () => {
    const log: string[] = []
    const client = fakeClient(1, log)
    let bodyRuns = 0

    const result = await withTransaction(
      async () => {
        bodyRuns++
        return 'held'
      },
      { connect: async () => client, baseDelayMs: 0 },
    )

    expect(result).toBe('held')
    expect(bodyRuns).toBe(2)
    expect(log.filter((s) => s === 'BEGIN')).toHaveLength(2)
    expect(log).toContain('ROLLBACK')
    // Every attempt returns its client: a retry loop that leaks one connection per conflict is a
    // slower way to fail than not retrying at all.
    expect(client.releaseCount).toBe(2)
  })

  it('gives up after maxAttempts and surfaces the retry error rather than hanging', async () => {
    const log: string[] = []
    const client = fakeClient(99, log)
    await expect(
      withTransaction(async () => 'never', {
        connect: async () => client,
        baseDelayMs: 0,
        maxAttempts: 3,
      }),
    ).rejects.toThrow(/restart transaction/)
    expect(log.filter((s) => s === 'BEGIN')).toHaveLength(3)
    expect(client.releaseCount).toBe(3)
  })

  it('does not retry an ordinary failure — the HOLD body is not free to run twice for fun', async () => {
    const log: string[] = []
    const client = fakeClient(0, log)
    let bodyRuns = 0
    await expect(
      withTransaction(
        async () => {
          bodyRuns++
          throw new Error('Bedrock timed out composing the advisory')
        },
        { connect: async () => client, baseDelayMs: 0 },
      ),
    ).rejects.toThrow(/Bedrock timed out/)
    expect(bodyRuns).toBe(1)
    expect(log).toEqual(['BEGIN', 'ROLLBACK', 'RELEASE'])
  })

  it('keeps the original error when the ROLLBACK itself fails, and destroys the client', async () => {
    const log: string[] = []
    const client = {
      async query(sql: string) {
        log.push(sql)
        // The connection died — which is why the body failed AND why the rollback cannot land.
        if (sql === 'ROLLBACK') throw new Error('Connection terminated unexpectedly')
        return { rows: [], rowCount: 0 }
      },
      release(err?: Error | boolean) {
        log.push(err ? 'RELEASE(destroy)' : 'RELEASE')
      },
    } as unknown as PoolClient

    await expect(
      withTransaction(
        async () => {
          throw new Error('the real problem')
        },
        { connect: async () => client, baseDelayMs: 0 },
      ),
    ).rejects.toThrow(/the real problem/)
    // A client whose transaction is still open must never go back into the pool.
    expect(log).toContain('RELEASE(destroy)')
  })
})

// The two audit paths are only interchangeable while they read the same database. The MCP session
// is pinned to a cluster and is handed one explicitly (scripts/mcp-audit.ts passes
// config.databaseName()); the direct reader used to accept that argument and drop it on the floor.
describe('showCreateTableSql — the direct path must name the database the MCP path names', () => {
  it('qualifies through the public schema when a database is supplied', () => {
    expect(showCreateTableSql('release_hold', 'sleeper')).toBe(
      'SHOW CREATE TABLE sleeper.public.release_hold',
    )
  })

  it('leaves it unqualified when there is none — the pg session is already inside a database', () => {
    expect(showCreateTableSql('events')).toBe('SHOW CREATE TABLE events')
  })

  it('validates the database with the same rule as the table, because both are identifiers', () => {
    expect(() => showCreateTableSql('events', 'sleeper; DROP DATABASE sleeper')).toThrow(
      /Not a plain database name/,
    )
    expect(() => showCreateTableSql('events', "sleeper' --")).toThrow(/Not a plain database name/)
    expect(() => showCreateTableSql('release_hold; SELECT 1', 'sleeper')).toThrow(
      /Not a plain table name/,
    )
  })

  // Quoting an identifier as a string literal is not a safer query, it is a broken one:
  // `SHOW CREATE TABLE 'sleeper'.public.events` is a syntax error. Validation is the substitute.
  it('never quotes an identifier as a string literal', () => {
    expect(showCreateTableSql('events', 'sleeper')).not.toContain("'")
  })

  it('rejects at the reader too, without recording a statement that never reached the cluster', async () => {
    const reader = directSqlReader('unit test — no cluster involved')
    await expect(reader.tableSchema('events', 'not a database')).rejects.toThrow(
      /Not a plain database name/,
    )
    expect(reader.calls).toEqual([])
  })
})

describe('holdEvidence — a wrapped payload is still not necessarily a row', () => {
  const HOLD_ID = '3f1c9d2e-1111-4000-8000-0123456789ab'

  /**
   * A reader that hands back a server payload parsed exactly as the real MCP client parses it, so
   * what is under test is `holdEvidence`'s handling of a row `parseRows` legitimately accepted.
   */
  function readerReturning(hold: string, rest = '{"rows":[]}'): SqlReader {
    return {
      via: 'mcp',
      reason: 'unit test — canned payload',
      calls: [],
      async select<T = Record<string, unknown>>(sql: string): Promise<T[]> {
        return parseRows<T>(sql.includes('FROM release_hold') ? hold : rest).rows
      },
      async explain(): Promise<string> {
        return ''
      },
      async tableSchema(): Promise<string> {
        return ''
      },
      async close(): Promise<void> {},
    }
  }

  const wrapped = (row: Record<string, unknown>): string => JSON.stringify({ rows: [row] })

  const good = {
    id: HOLD_ID,
    package_id: 'xz-utils',
    release_version: '5.6.0',
    reason: 'behavioural arc matches a known takeover shape',
    similarity: 0.87,
    created_at: '2024-02-24T00:00:00Z',
  }

  it('renders a well-formed wrapped payload — including a date explain.ts can format', async () => {
    const evidence = await holdEvidence(HOLD_ID, readerReturning(wrapped(good)))
    expect(evidence!.hold.similarity).toBeCloseTo(0.87)
    expect(evidence!.hold.createdAt.toISOString()).toBe('2024-02-24T00:00:00.000Z')
  })

  it('still answers null when the hold genuinely does not exist', async () => {
    expect(await holdEvidence(HOLD_ID, readerReturning('{"rows":[]}'))).toBeNull()
  })

  // `scripts/explain.ts` calls `.toISOString()` on this. Without the check the judge-facing failure
  // is `RangeError: Invalid time value` — a stack trace that names neither the column nor the path.
  it('rejects a row with no created_at, naming the column', async () => {
    const { created_at: _dropped, ...noDate } = good
    const promise = holdEvidence(HOLD_ID, readerReturning(wrapped(noDate)))
    await expect(promise).rejects.toThrow(MalformedRowError)
    await expect(promise).rejects.toThrow(/created_at/)
  })

  it('rejects a row with no id rather than citing an empty one', async () => {
    const { id: _dropped, ...noId } = good
    await expect(holdEvidence(HOLD_ID, readerReturning(wrapped(noId)))).rejects.toThrow(/`id`/)
  })

  it('rejects a similarity that coerces to NaN instead of printing NaN as a score', async () => {
    await expect(
      holdEvidence(HOLD_ID, readerReturning(wrapped({ ...good, similarity: 'n/a' }))),
    ).rejects.toThrow(/similarity/)
  })

  // A null in a NOT NULL column means the payload is wrong, and `Number(null)` is 0 — a confident
  // 0.0000 that no query produced.
  it('rejects a null similarity too, rather than reporting it as 0.0000', async () => {
    await expect(
      holdEvidence(HOLD_ID, readerReturning(wrapped({ ...good, similarity: null }))),
    ).rejects.toThrow(MalformedRowError)
  })

  it('rejects an unparseable created_at, not just a missing one', async () => {
    await expect(
      holdEvidence(HOLD_ID, readerReturning(wrapped({ ...good, created_at: 'yesterday' }))),
    ).rejects.toThrow(/created_at/)
  })
})

describe('arcWindow', () => {
  it('opens the window exactly windowDays before the assessment point', () => {
    const w = arcWindow(new Date('2024-02-24T00:00:00Z'), 90, 4)
    expect(w.windowStart.toISOString()).toBe('2023-11-26T00:00:00.000Z')
    expect(w.windowEnd.toISOString()).toBe('2024-02-24T00:00:00.000Z')
    expect(w.eventCount).toBe(4)
  })
})

describe('extractVersion', () => {
  it('pulls a semantic version out of release prose', () => {
    expect(extractVersion('Publishes the xz-utils 5.6.0 release tarball.', 'x')).toBe('5.6.0')
  })

  it('accepts two-part versions', () => {
    expect(extractVersion('tags 5.4 and moves on', 'x')).toBe('5.4')
  })

  it('falls back when there is no version to find', () => {
    expect(extractVersion('publishes a release', '2024-02-24')).toBe('2024-02-24')
  })
})

describe('bundled corpora', () => {
  const timeline = loadTimeline()
  const synthetic = loadSynthetic()

  it('loads the xz timeline with every event mapped to the package', () => {
    expect(timeline.packageId).toBe('xz-utils')
    expect(timeline.events.length).toBeGreaterThanOrEqual(20)
    expect(timeline.events.every((e) => e.packageId === 'xz-utils')).toBe(true)
  })

  it('gives every event a parseable timestamp and a known actor', () => {
    for (const e of timeline.events) {
      expect(Number.isNaN(Date.parse(e.occurredAt))).toBe(false)
      expect(timeline.actors[e.actorId]).toBeDefined()
    }
  })

  it('contains the 5.6.0 release that the hold must fire on', () => {
    const releases = timeline.events.filter((e) => e.kind === 'release')
    expect(releases.some((e) => extractVersion(e.content, '') === '5.6.0')).toBe(true)
  })

  it('keeps the playbook and held-out splits disjoint', () => {
    const playbook = new Set(synthetic.playbook.map((a) => a.id))
    expect(synthetic.heldout.some((a) => playbook.has(a.id))).toBe(false)
  })

  it('never reuses the same arc text across the two splits', () => {
    const texts = new Set(synthetic.playbook.map((a) => a.arc_summary))
    expect(synthetic.heldout.some((a) => texts.has(a.arc_summary))).toBe(false)
  })

  it('balances both splits across labels so the metrics are not trivially winnable', () => {
    for (const split of [synthetic.playbook, synthetic.heldout]) {
      const takeover = split.filter((a) => a.label === 'takeover').length
      expect(takeover).toBe(split.length - takeover)
      expect(takeover).toBeGreaterThanOrEqual(3)
    }
  })
})
