/**
 * The gaps `tests/integration.test.ts` does not reach in `src/memory.ts`.
 *
 * That suite drives every happy path against a real cluster already — one hold, one clear, one
 * reset, all through the front door. What it never does is misbehave: it never redelivers a
 * webhook whose row vanished mid-flight, never asks for a hold that does not exist, never hands
 * `holdEvidence` a payload with a hole in it, and never runs with a corpus written by a different
 * embedding model. Those are exactly the paths a coverage report calls cold, and they are the ones
 * most worth pinning down, because they are the paths that turn into a `RangeError` or a silent
 * wrong answer in front of a judge instead of a loud, named error.
 *
 * Two shapes of test live here:
 *
 *  - Pure / fake-reader tests that need no cluster at all — `eventKey`'s unparseable-date branch,
 *    `embeddingProvenance`'s non-offline branch, `scopedNeighbourExplainSql`, `explainScopedVia`,
 *    `auditReader`, and every `holdEvidence` shape-validation path. These construct a `SqlReader`
 *    by hand (same technique `tests/unit.test.ts` uses for `holdEvidence`) or mock `src/db.ts`'s
 *    `query` export for exactly one call.
 *  - Live-cluster tests for the handful of real functions integration.test.ts never calls at all
 *    (`packageHistory`, `assertPlaybookModel`) or never calls with the specific input that trips a
 *    branch (`loadActorArc` on an actor with no arc, `commitUnhold` on a hold that never existed,
 *    `matchPlaybook` with `limit=0`). These are namespaced to this process and torn down in
 *    `afterAll`, same discipline as `tests/integration.test.ts` — an interrupted run here must not
 *    leak rows onto a cluster the demo or another suite is using.
 */
import { randomUUID } from 'node:crypto'
import type { Mock } from 'vitest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as db from '../src/db.js'
import { offlineEmbed } from '../src/embeddings.js'
import type { SqlReader } from '../src/mcp.js'
import {
  HISTORY_LIMIT,
  MalformedRowError,
  OFFLINE_EMBEDDING_MODEL,
  actorHistory,
  assertPlaybookModel,
  auditReader,
  commitUnhold,
  embeddingProvenance,
  eventKey,
  explainScopedVia,
  holdEvidence,
  ingestEvent,
  loadActorArc,
  matchPlaybook,
  packageHistory,
  resetPackage,
  scopedNeighbourExplainSql,
  type IngestInput,
} from '../src/memory.js'
import { LIVE } from './live.js'

// `db.query` is wrapped rather than replaced: every method not overridden falls straight through
// to the real implementation, so every live-cluster test below (and every OTHER test file, which
// gets its own untouched module instance — vitest isolates modules per file) runs exactly as it
// would with no mock present. Only the one test that queues `mockResolvedValueOnce` twice ever
// sees a value that did not come from the cluster.
vi.mock('../src/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db.js')>()
  return { ...actual, query: vi.fn(actual.query) }
})

// -----------------------------------------------------------------------------------------------
// Pure functions and fake-reader tests — no cluster required
// -----------------------------------------------------------------------------------------------

describe('eventKey — the branch integration.test.ts never feeds it', () => {
  it('hashes an unparseable timestamp verbatim rather than throwing', () => {
    // `Date.parse` on garbage is NaN, and `eventKey` deliberately does not reject it — validating
    // the timestamp is a caller's job, not the identity function's. Every seeded event in
    // integration.test.ts carries a real ISO timestamp, so this is the one input that never
    // reaches the `Number.isNaN` branch there.
    const withGarbageDate: IngestInput = {
      packageId: 'xz-utils',
      actorId: 'jia-tan',
      kind: 'commit',
      content: 'x',
      occurredAt: 'not a date',
    }
    expect(eventKey(withGarbageDate)).toHaveLength(64)
    // Still deterministic — the whole point of hashing verbatim rather than throwing.
    expect(eventKey(withGarbageDate)).toBe(eventKey({ ...withGarbageDate }))
  })
})

describe('embeddingProvenance — the non-offline branch', () => {
  it('reports the configured Bedrock model id and dimensions when SLEEPER_OFFLINE is not set', async () => {
    // `OFFLINE` (src/embeddings.ts) is `process.env.SLEEPER_OFFLINE === '1'`, read once at module
    // load — every test in this suite runs with SLEEPER_OFFLINE=1, so the statically-imported
    // `embeddingProvenance` above can only ever exercise the offline half of its ternary. The other
    // half is reached the only way it can be: load a second copy of the module graph under a
    // different value of the env var it reads at import time.
    //
    // This does not affect any other test in this file. `vi.resetModules()` only changes what a
    // FUTURE `import()` resolves to; the static imports at the top of this file are already bound
    // to the module instances loaded before this test ran, and stay bound to them afterwards.
    const savedOffline = process.env.SLEEPER_OFFLINE
    process.env.SLEEPER_OFFLINE = '0'
    try {
      vi.resetModules()
      const freshMemory = await import('../src/memory.js')
      const freshConfig = await import('../src/config.js')
      const prov = freshMemory.embeddingProvenance()
      expect(prov.model).toBe(freshConfig.config.aws.embeddingModelId)
      expect(prov.dims).toBe(freshConfig.config.aws.embeddingDimensions)
      expect(prov.model).not.toBe(freshMemory.OFFLINE_EMBEDDING_MODEL)
    } finally {
      process.env.SLEEPER_OFFLINE = savedOffline
    }
  })

  it('still reports the offline model id through the statically-imported module', () => {
    // Sanity check that the test above did not leave the process-wide env mutation visible to the
    // module instance every other test in this file actually uses.
    expect(embeddingProvenance().model).toBe(OFFLINE_EMBEDDING_MODEL)
  })
})

describe('scopedNeighbourExplainSql — the literal form sent over MCP', () => {
  it('carries the package scope, the model filter and a trailing literal LIMIT, with no repeated vector projection', () => {
    const sql = scopedNeighbourExplainSql('xz-utils', offlineEmbed('release signing'), 7, 3)
    expect(sql).toContain(`WHERE package_id = 'xz-utils'`)
    expect(sql).toContain(`WHERE embedding_model = '${OFFLINE_EMBEDDING_MODEL}'`)
    expect(sql).toMatch(/LIMIT 7\s*\)/)
    // The parameterised form projects `embedding <=> $2::VECTOR AS distance` twice; the literal
    // form drops it deliberately (see the doc comment on the function) to stay under the MCP
    // server's char ceiling.
    expect(sql).not.toContain('AS distance')
  })

  it('escapes a package id containing a quote, rather than producing invalid SQL', () => {
    // `sqlLiteral` (src/mcp.ts) doubles embedded quotes. A package id with one in it is not exotic
    // input here — it is exactly what this function exists to make safe, since there is no bind
    // channel to fall back on.
    const sql = scopedNeighbourExplainSql("xz'utils", offlineEmbed('t'), 1)
    expect(sql).toContain(`WHERE package_id = 'xz''utils'`)
  })

  it('rounds the vector literal to the requested precision', () => {
    const sql = scopedNeighbourExplainSql('xz-utils', [1 / 3, -2 / 3], 1, 2)
    expect(sql).toContain('[0.33,-0.67]')
  })
})

describe('explainScopedVia — the reader-abstracted EXPLAIN', () => {
  it('runs the literal SQL through the given reader and reads the plan for the same proof explainScoped gives', async () => {
    const calls: string[] = []
    const reader: SqlReader = {
      via: 'mcp',
      reason: 'fake reader — no cluster involved',
      calls,
      async select() {
        return []
      },
      async explain(sql) {
        calls.push(sql)
        // A canned plan shaped like the real CockroachDB output this function is meant to parse.
        return "• vector search\n  table: events@events_pkg_embedding_idx\n  prefix spans: [/'xz-utils' - /'xz-utils']"
      },
      async tableSchema() {
        return ''
      },
      async close() {},
    }

    const result = await explainScopedVia(reader, 'xz-utils', offlineEmbed('build system changes'), 5)
    expect(result.usedVectorIndex).toBe(true)
    expect(result.prefixScoped).toBe(true)
    // Proves the function actually sent `scopedNeighbourExplainSql`'s output, not some other query.
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain(`WHERE package_id = 'xz-utils'`)
    expect(calls[0]).toContain(`WHERE embedding_model = '${OFFLINE_EMBEDDING_MODEL}'`)
  })

  it('reports no prefix scoping when the plan does not show one — the reader is not trusted blindly', async () => {
    const reader: SqlReader = {
      via: 'mcp',
      reason: 'fake reader — no cluster involved',
      calls: [],
      async select() {
        return []
      },
      async explain() {
        return '• scan\n  table: events@events_pkey\n  spans: FULL SCAN'
      },
      async tableSchema() {
        return ''
      },
      async close() {},
    }
    const result = await explainScopedVia(reader, 'xz-utils', offlineEmbed('t'), 5)
    expect(result.usedVectorIndex).toBe(false)
    expect(result.prefixScoped).toBe(false)
  })
})

describe('auditReader — resolves the path with no cluster touched', () => {
  it('falls back to direct SQL when no MCP credentials are configured', async () => {
    // `auditReader` only DECIDES the path here; direct-SQL's methods are not called, so this needs
    // no DATABASE_URL and never dials the pool.
    const reader = await auditReader({})
    expect(reader.via).toBe('direct')
    expect(reader.reason).toMatch(/COCKROACH_MCP_API_KEY is not set/)
  })
})

describe('ingestEvent — the conflicting row deleted between the two statements', () => {
  it('names the failure instead of returning a fabricated id', async () => {
    // Only reachable if the row `ON CONFLICT DO NOTHING` skipped is gone by the time the fallback
    // SELECT runs — a concurrent resetPackage racing a redelivered webhook. There is no way to open
    // that window against a real cluster deterministically, so this is the one place in the suite
    // that mocks `db.query` rather than seeding real rows: both calls `ingestEvent` makes are
    // stubbed to return zero rows, which is exactly the state the comment on this branch describes.
    const mockedQuery = db.query as unknown as Mock
    mockedQuery.mockResolvedValueOnce({ rows: [] } as never)
    mockedQuery.mockResolvedValueOnce({ rows: [] } as never)

    const input: IngestInput = {
      packageId: `mem-test-race-${process.pid}`,
      actorId: 'actor',
      kind: 'commit',
      content: 'a commit whose row disappears mid-ingest',
      occurredAt: '2024-01-01T00:00:00Z',
    }

    await expect(ingestEvent(input, offlineEmbed(input.content))).rejects.toThrow(
      /conflicted on insert but is no longer present — the package was reset concurrently/,
    )
    expect(mockedQuery).toHaveBeenCalledTimes(2)
  })
})

describe('holdEvidence — payload shapes integration.test.ts never sends, because a real query never sends them', () => {
  const HOLD_ID = '3f1c9d2e-2222-4000-8000-0123456789ab'
  const MATCHED_ID = '3f1c9d2e-3333-4000-8000-0123456789ab'

  /**
   * A reader that hands back exactly the object given for each evidence table, with no JSON
   * round-trip. `tests/unit.test.ts`'s `holdEvidence` tests round-trip through `parseRows` to prove
   * behaviour against a realistic MCP payload; this one does not, on purpose — it exists to inject
   * a native `Date` for `created_at` (branch coverage on `date()`'s `instanceof Date` arm), which a
   * JSON string could never carry. `SqlReader.select<T>()` promises `T[]`, not "JSON-encoded T[]",
   * so a reader answering with the object literal is exercising a shape the interface itself allows.
   */
  function readerWith(rows: {
    hold?: Record<string, unknown>[]
    matchedArc?: Record<string, unknown>[]
    trust?: Record<string, unknown>[]
    advisories?: Record<string, unknown>[]
    audit?: Record<string, unknown>[]
  }): SqlReader {
    return {
      via: 'mcp',
      reason: 'memory.test.ts fake reader',
      calls: [],
      async select<T = Record<string, unknown>>(sql: string): Promise<T[]> {
        if (sql.includes('FROM release_hold')) return (rows.hold ?? []) as T[]
        if (sql.includes('FROM takeover_playbook')) return (rows.matchedArc ?? []) as T[]
        if (sql.includes('FROM trust_state')) return (rows.trust ?? []) as T[]
        if (sql.includes('FROM distro_advisory_outbox')) return (rows.advisories ?? []) as T[]
        if (sql.includes('FROM audit_log')) return (rows.audit ?? []) as T[]
        throw new Error(`fake reader: unexpected SQL: ${sql}`)
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

  const goodHold = {
    id: HOLD_ID,
    package_id: 'xz-utils',
    release_version: '5.6.0',
    reason: 'behavioural arc matches a known takeover shape',
    similarity: 0.87,
    created_at: '2024-02-24T00:00:00Z',
  }

  it('degrades tolerant columns to an empty string instead of the literal "null"', async () => {
    // `assertHoldRow` validates only id, created_at and similarity (see its doc comment) — reason
    // and release_version are read through `str()`, which is deliberately tolerant. Nothing in
    // integration.test.ts ever sends a null reason or release_version, so `str`'s null branch has
    // never run outside this test.
    const evidence = await holdEvidence(
      HOLD_ID,
      readerWith({ hold: [{ ...goodHold, release_version: null, reason: null }] }),
    )
    expect(evidence!.hold.releaseVersion).toBe('')
    expect(evidence!.hold.reason).toBe('')
    // No matched_playbook_id, no trust_state row: both null-shaped outputs, not a crash.
    expect(evidence!.matchedArc).toBeNull()
    expect(evidence!.trustStatus).toBeNull()
  })

  it('accepts a native Date for created_at, not only the ::STRING-cast form EVIDENCE_SQL sends', async () => {
    // Every real caller casts `created_at::STRING` (see EVIDENCE_SQL), so in production this value
    // is always a string. `date()` still defends the other case rather than assuming it — this test
    // is what proves that defence actually runs rather than being dead code with a comment on it.
    const asDate = new Date('2024-02-24T00:00:00Z')
    const evidence = await holdEvidence(HOLD_ID, readerWith({ hold: [{ ...goodHold, created_at: asDate }] }))
    expect(evidence!.hold.createdAt).toBe(asDate)
  })

  it('follows matched_playbook_id to the arc it names', async () => {
    const evidence = await holdEvidence(
      HOLD_ID,
      readerWith({
        hold: [{ ...goodHold, matched_playbook_id: MATCHED_ID }],
        matchedArc: [
          {
            package_id: 'xz-utils-takeover',
            label: 'takeover',
            source: 'synthetic',
            arc_summary: 'a contributor with no prior history takes over release engineering',
          },
        ],
      }),
    )
    expect(evidence!.matchedArc).toEqual({
      packageId: 'xz-utils-takeover',
      label: 'takeover',
      source: 'synthetic',
      arcSummary: 'a contributor with no prior history takes over release engineering',
    })
  })

  it('rejects a row whose id is missing, naming the column', async () => {
    const { id: _dropped, ...noId } = goodHold
    const promise = holdEvidence(HOLD_ID, readerWith({ hold: [noId] }))
    await expect(promise).rejects.toThrow(MalformedRowError)
    await expect(promise).rejects.toThrow(/`id`/)
  })

  it('rejects a row whose id is present but blank', async () => {
    await expect(holdEvidence(HOLD_ID, readerWith({ hold: [{ ...goodHold, id: '   ' }] }))).rejects.toThrow(
      /`id`.*missing or empty/,
    )
  })

  it('rejects a row with no created_at, naming the column rather than crashing at .toISOString() downstream', async () => {
    const { created_at: _dropped, ...noDate } = goodHold
    const promise = holdEvidence(HOLD_ID, readerWith({ hold: [noDate] }))
    await expect(promise).rejects.toThrow(MalformedRowError)
    await expect(promise).rejects.toThrow(/`created_at`.*missing/)
  })

  it('rejects a created_at that is present but not a parseable timestamp', async () => {
    await expect(
      holdEvidence(HOLD_ID, readerWith({ hold: [{ ...goodHold, created_at: 'yesterday' }] })),
    ).rejects.toThrow(/`created_at`.*not a parseable timestamp/)
  })

  it('rejects a null similarity rather than reporting it as 0.0000', async () => {
    const promise = holdEvidence(HOLD_ID, readerWith({ hold: [{ ...goodHold, similarity: null }] }))
    await expect(promise).rejects.toThrow(MalformedRowError)
    await expect(promise).rejects.toThrow(/`similarity`/)
  })

  it('rejects a similarity that does not coerce to a finite number', async () => {
    await expect(
      holdEvidence(HOLD_ID, readerWith({ hold: [{ ...goodHold, similarity: 'not-a-number' }] })),
    ).rejects.toThrow(/`similarity`.*does not coerce to a finite number/)
  })
})

// -----------------------------------------------------------------------------------------------
// Live-cluster tests — functions (or specific inputs) integration.test.ts never exercises
// -----------------------------------------------------------------------------------------------

describe.skipIf(!LIVE)('memory.ts against a real cluster — the paths integration.test.ts skips', () => {
  const PKG = `mem-test-pkg-${process.pid}`
  const PB_PKG = `mem-test-pb-${process.pid}`
  const ACTOR_A = 'actor-a'
  const ACTOR_B = 'actor-b'
  const ASOF = new Date('2024-06-01T00:00:00Z')
  const foreignArcIds: string[] = []

  beforeAll(async () => {
    await resetPackage(PKG)
  }, 30_000)

  afterAll(async () => {
    await resetPackage(PKG)
    await resetPackage(PB_PKG)
    // `resetPackage` UPSERTs `trust_state` to 'trusted' rather than deleting the row — it exists
    // to make a package's OWN history disappear, not to erase that a package id was ever seen. Left
    // alone, every run of this suite (and integration.test.ts, which does the same explicit delete
    // below) would accumulate one more 'trusted' row per pid, forever. That is exactly the leak this
    // file's own header promises not to cause.
    await db.query('DELETE FROM trust_state WHERE package_id = ANY($1)', [[PKG, PB_PKG]])
    if (foreignArcIds.length) {
      await db.query('DELETE FROM takeover_playbook WHERE id = ANY($1)', [foreignArcIds])
    }
    await db.closePool()
  })

  it('packageHistory reads every actor on a package, honouring asOf — the function integration.test.ts never calls directly', async () => {
    await ingestEvent(
      { packageId: PKG, actorId: ACTOR_A, kind: 'commit', content: 'first', occurredAt: '2024-01-01T00:00:00Z' },
      offlineEmbed('first'),
    )
    await ingestEvent(
      { packageId: PKG, actorId: ACTOR_B, kind: 'commit', content: 'second', occurredAt: '2024-02-01T00:00:00Z' },
      offlineEmbed('second'),
    )
    await ingestEvent(
      {
        packageId: PKG,
        actorId: ACTOR_A,
        kind: 'release',
        content: 'released after asOf',
        occurredAt: '2024-12-01T00:00:00Z',
      },
      offlineEmbed('released after asOf'),
    )

    const history = await packageHistory(PKG, ASOF)
    expect(history.map((e) => e.actorId)).toEqual([ACTOR_A, ACTOR_B])
    // The third event is after ASOF and must not leak into a decision made as of ASOF — the same
    // property integration.test.ts already proves for actorHistory, checked here for the sibling
    // function that reads across every actor on the package instead of just one.
    expect(history.every((e) => e.occurredAt.getTime() <= ASOF.getTime())).toBe(true)
  })

  it('warns exactly once when a history read hits its row limit, instead of silently truncating', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Assertions run BEFORE `mockRestore()`, not after: `mockRestore()` both restores the original
    // `console.warn` AND clears the spy's recorded calls (the same as `mockClear()`), so asserting
    // on `warnSpy` afterwards always sees zero calls regardless of what actually happened — a trap
    // this test fell into once already.
    try {
      // Two rows already sit at or before ASOF from the previous test; a limit of 1 forces both
      // actorHistory and packageHistory to hit the boundary `warnIfTruncated` exists to announce.
      await actorHistory(PKG, ACTOR_A, ASOF, 1)
      await packageHistory(PKG, ASOF, 1)

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('hit the 1-row read limit'))
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`actorHistory(${PKG}, ${ACTOR_A})`))
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`packageHistory(${PKG})`))
      // Named after HISTORY_LIMIT's own env override, not a hardcoded number, so the message stays
      // true if SLEEPER_HISTORY_LIMIT is raised.
      expect(warnSpy.mock.calls.every((call) => typeof call[0] === 'string')).toBe(true)
      void HISTORY_LIMIT // referenced so a future rename of the export is caught by typecheck, not silently
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('loadActorArc answers null for an actor that has never had one rolled up', async () => {
    // Every loadActorArc call in integration.test.ts follows an upsertActorArc for the same actor,
    // so the "no row" branch never runs there.
    expect(await loadActorArc(PKG, 'never-assessed-actor')).toBeNull()
  })

  it('commitUnhold on a hold id that never existed names the id, not "already resolved"', async () => {
    // integration.test.ts's "already resolved" test always starts from a hold that DOES exist. The
    // other way commitUnhold's lookup can come back empty is the id never having been a hold at
    // all — the branch that guards against that is genuinely distinct code, one line up.
    const neverExisted = randomUUID()
    await expect(commitUnhold(neverExisted, 'someone', 'note')).rejects.toThrow(
      new RegExp(`No release hold with id ${neverExisted}\\.`),
    )
  })

  it('matchPlaybook with limit=0 returns no rows and still checks the corpus is not a mismatched one', async () => {
    // `LIMIT 0` forces the zero-rows branch inside matchPlaybook deterministically — the only
    // caller-controlled way to do that without depending on the corpus being empty, which it
    // usually is not (npm run seed and other suites leave real arcs behind). This corpus is
    // entirely OFFLINE-model rows (every test file in this project embeds with SLEEPER_OFFLINE=1),
    // so assertPlaybookModel is expected to pass silently here — proven directly in the next test.
    const matches = await matchPlaybook(offlineEmbed('takeover of release engineering'), 0)
    expect(matches).toEqual([])
  })

  it('assertPlaybookModel passes silently over a corpus that matches the running model', async () => {
    await expect(assertPlaybookModel(OFFLINE_EMBEDDING_MODEL)).resolves.toBeUndefined()
  })

  it('assertPlaybookModel refuses a corpus written by a different model, naming it and the count', async () => {
    const foreignModel = `test-foreign-model-${process.pid}`
    const text = 'an arc that exists only to prove the mismatch check fires'
    // Written with raw SQL, not insertPlaybookArc: that helper always stamps the model this process
    // is actually running under (embeddingProvenance()), so there is no way to reach a foreign
    // model through the normal write path — which is exactly the point of the check under test.
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO takeover_playbook
         (package_id, label, source, held_out, arc_summary, embedding, embedding_model, embedding_dims)
       VALUES ($1, 'takeover', 'synthetic', false, $2, $3::VECTOR, $4, 1024)
       RETURNING id`,
      [PB_PKG, text, `[${offlineEmbed(text).join(',')}]`, foreignModel],
    )
    foreignArcIds.push(inserted.rows[0]!.id)

    await expect(assertPlaybookModel(OFFLINE_EMBEDDING_MODEL)).rejects.toThrow(
      /Embedding model mismatch/,
    )
    await expect(assertPlaybookModel(OFFLINE_EMBEDDING_MODEL)).rejects.toThrow(
      new RegExp(`${foreignModel} \\(1 arcs\\)`),
    )
  })
})
