/**
 * Integration tests against a real CockroachDB cluster.
 *
 * Skipped unless DATABASE_URL is set, so `npm test` stays green on a clean checkout. To run them:
 *
 *   cockroach start-single-node --insecure --listen-addr=localhost:26257 --store=/tmp/sleeper-crdb
 *   cockroach sql --insecure -e 'CREATE DATABASE sleeper'
 *   DATABASE_URL='postgresql://root@localhost:26257/sleeper?sslmode=disable' npm run schema
 *   DATABASE_URL='postgresql://root@localhost:26257/sleeper?sslmode=disable' npm test
 *
 * These use the offline embedder directly: what is under test is the SQL, the index behaviour and
 * the transaction semantics, none of which depend on which model produced the vector.
 *
 * Everything is namespaced to a per-run package id and torn down afterwards, so they are safe to
 * point at the same cluster the demo uses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { offlineEmbed } from '../src/embeddings.js'
import { closePool, query, withTransaction } from '../src/db.js'
import {
  ACTOR_HISTORY_SQL,
  HISTORY_LIMIT,
  OFFLINE_EMBEDDING_MODEL,
  PACKAGE_HISTORY_SQL,
  actorHistory,
  arcWindow,
  clearPlaybook,
  commitHold,
  commitUnhold,
  explainPlaybook,
  explainScoped,
  holdEvidence,
  ingestEvent,
  insertPlaybookArc,
  loadActorArc,
  matchPlaybook,
  playbookArcs,
  resetPackage,
  scopedNeighbours,
  upsertActorArc,
} from '../src/memory.js'
import { LIVE as liveCluster } from './live.js'

// Reachability, not just presence — see tests/live.ts for why the distinction matters.
const LIVE = liveCluster

// Distinct per run so a failed run never poisons the next one, and so these can share a cluster
// with the demo without touching xz-utils rows.
const PKG = `test-pkg-${process.pid}`
const OTHER_PKG = `test-other-${process.pid}`
// Two more, owned by the trust-state invariant test at the bottom of the file.
const ONLY_CITING = `${PKG}-clear-only-citing`
const ALSO_UNCITED = `${PKG}-clear-also-uncited`
// Owned by the test that proves the INVERSE invariant check is not vacuous.
const UNMARKED_HELD = `${PKG}-open-hold-unmarked`
const ACTOR = 'test-actor'
const ASOF = new Date('2024-02-24T00:00:00Z')

const playbookIds: string[] = []

async function seedEvent(kind: string, content: string, occurredAt: string, pkg = PKG): Promise<string> {
  return ingestEvent(
    { packageId: pkg, actorId: ACTOR, kind, content, occurredAt },
    offlineEmbed(content),
  )
}

type ArcRow = {
  id: string
  package_id: string
  label: string
  source: string
  held_out: boolean
  arc_summary: string
  embedding: string
  embedding_model: string
  embedding_dims: number
}
type HoldRow = {
  id: string
  package_id: string
  release_version: string
  reason: string
  matched_playbook_id: string | null
  similarity: number
  created_at: Date
  resolution: string | null
  resolved_by: string | null
  resolved_at: Date | null
  resolution_note: string | null
}
type AdvisoryRow = { id: string; release_hold_id: string; advisory_text: string; sent: boolean; created_at: Date }
type AuditRow = { id: string; release_hold_id: string; actor: string; action: string; detail: string | null; created_at: Date }
type TrustRow = { package_id: string; status: string; updated_at: Date }
type ForeignRows = {
  arcs: ArcRow[]
  holds: HoldRow[]
  advisories: AdvisoryRow[]
  audit: AuditRow[]
  trust: TrustRow[]
}

/**
 * Everything in the cluster that this suite does NOT own, captured so a forced `clearPlaybook` can
 * be undone.
 *
 * `clearPlaybook` has no package scope and cannot have one — the corpus is global by design, that
 * is the whole point of matching a shape learned in one ecosystem from another package. So the
 * forced path deletes every playbook row in the cluster and, with it, every hold that cites one.
 * DEMO.md tells a judge to point this suite at the same cluster the demo runs on, so any test that
 * reaches for the escape hatch snapshots the rows it does not own and puts them back afterwards,
 * ids included. A test that ate the demo's hold in order to prove that holds are safe would be a
 * poor joke.
 */
async function snapshotForeignRows(ownArcIds: string[], ownPackages: string[]): Promise<ForeignRows> {
  const arcs = await query<ArcRow>(
    `SELECT id, package_id, label, source, held_out, arc_summary, embedding::STRING AS embedding,
            embedding_model, embedding_dims
     FROM takeover_playbook WHERE NOT (id = ANY($1))`,
    [ownArcIds],
  )
  const holds = await query<HoldRow>(
    'SELECT * FROM release_hold WHERE NOT (package_id = ANY($1))',
    [ownPackages],
  )
  const holdIds = holds.rows.map((r) => r.id)
  const advisories = holdIds.length
    ? (await query<AdvisoryRow>('SELECT * FROM distro_advisory_outbox WHERE release_hold_id = ANY($1)', [holdIds])).rows
    : []
  const audit = holdIds.length
    ? (await query<AuditRow>('SELECT * FROM audit_log WHERE release_hold_id = ANY($1)', [holdIds])).rows
    : []
  // `trust_state` is part of the snapshot because the forced clear rewrites it: it sets every
  // package whose last citing hold is about to vanish back to 'trusted'. Restoring the holds
  // without restoring the claim they justify leaves the mirror image of the state this suite
  // exists to forbid — an open hold on a package the UI reports as trusted, i.e. a hold nobody is
  // enforcing. That is not hypothetical: it is how the demo cluster's `xz-utils-notice-preview`
  // lane ended up trusted while still holding an open hold.
  const trust = await query<TrustRow>(
    'SELECT package_id, status, updated_at FROM trust_state WHERE NOT (package_id = ANY($1))',
    [ownPackages],
  )
  return { arcs: arcs.rows, holds: holds.rows, advisories, audit, trust: trust.rows }
}

/**
 * Puts a snapshot back, in foreign-key order: arcs, then the holds that cite them, then their
 * advisories and audit rows. Ids are preserved so anything that cited a restored row — `npm run
 * explain -- --hold <uuid>` in DEMO.md, for one — still resolves.
 *
 * Every insert is ON CONFLICT DO NOTHING because the clear is deliberately PARTIAL: only holds that
 * cite the corpus are forced out by the foreign key, so a pre-existing hold that cites nothing is
 * still sitting there, untouched, along with its advisory and audit rows. Restoring unconditionally
 * would collide with the rows that never left.
 */
async function restoreForeignRows(rows: ForeignRows): Promise<void> {
  for (const a of rows.arcs) {
    await query(
      `INSERT INTO takeover_playbook
         (id, package_id, label, source, held_out, arc_summary, embedding, embedding_model, embedding_dims)
       VALUES ($1, $2, $3, $4, $5, $6, $7::VECTOR, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      [a.id, a.package_id, a.label, a.source, a.held_out, a.arc_summary, a.embedding, a.embedding_model, a.embedding_dims],
    )
  }
  for (const h of rows.holds) {
    await query(
      `INSERT INTO release_hold
         (id, package_id, release_version, reason, matched_playbook_id, similarity, created_at,
          resolution, resolved_by, resolved_at, resolution_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO NOTHING`,
      [h.id, h.package_id, h.release_version, h.reason, h.matched_playbook_id, h.similarity,
       h.created_at, h.resolution, h.resolved_by, h.resolved_at, h.resolution_note],
    )
  }
  for (const d of rows.advisories) {
    await query(
      `INSERT INTO distro_advisory_outbox (id, release_hold_id, advisory_text, sent, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [d.id, d.release_hold_id, d.advisory_text, d.sent, d.created_at],
    )
  }
  for (const l of rows.audit) {
    await query(
      `INSERT INTO audit_log (id, release_hold_id, actor, action, detail, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [l.id, l.release_hold_id, l.actor, l.action, l.detail, l.created_at],
    )
  }
  // Trust status goes back LAST, once the evidence it points at is in place, and it is the one
  // restore that must OVERWRITE: the clear updated these rows rather than deleting them, so DO
  // NOTHING would silently leave the rewritten status behind on every foreign package.
  for (const t of rows.trust) {
    await query(
      `INSERT INTO trust_state (package_id, status, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (package_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
      [t.package_id, t.status, t.updated_at],
    )
  }
}

/**
 * Every package whose `trust_state` says 'held' while no open hold exists to justify it.
 *
 * Deliberately unscoped: this is a cluster-wide invariant, not a property of one test's rows. The
 * whole demo rests on it — a package that claims to be held and can produce no hold, no advisory
 * and no audit row is the single most damaging state this UI can be in, and it is indistinguishable
 * from a lost paper trail.
 */
async function orphanedHeldPackages(): Promise<string[]> {
  const result = await query<{ package_id: string }>(
    `SELECT t.package_id FROM trust_state t
      WHERE t.status = 'held'
        AND NOT EXISTS (
          SELECT 1 FROM release_hold h WHERE h.package_id = t.package_id AND h.resolution IS NULL
        )
      ORDER BY t.package_id`,
  )
  return result.rows.map((r) => r.package_id)
}

/**
 * The same invariant read from the other end: every package carrying an OPEN hold that
 * `trust_state` does not report as held.
 *
 * The check above catches a claim with no evidence. This one catches evidence with no claim, and it
 * is arguably the worse of the two: an orphaned 'held' status blocks a release that should ship and
 * is loudly wrong the moment anyone asks it for the hold, while an unmarked open hold is silently
 * wrong — `/api/state` says trusted, the operator sees nothing to review, and a hold sits open with
 * nobody enforcing it and an advisory already queued to the distros. `trust_state` has no foreign
 * key to `release_hold` and cannot get one (the relation is "any open hold", not "this row"), so
 * both directions have to be asserted, not assumed.
 *
 * A missing `trust_state` row counts as a violation, not as an exemption: the demo server reads the
 * status from this table and treats an absent row as trusted.
 */
async function heldPackagesNotMarked(): Promise<string[]> {
  const result = await query<{ package_id: string }>(
    `SELECT DISTINCT h.package_id FROM release_hold h
      WHERE h.resolution IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM trust_state t WHERE t.package_id = h.package_id AND t.status = 'held'
        )
      ORDER BY h.package_id`,
  )
  return result.rows.map((r) => r.package_id)
}

/** EXPLAIN output for a parameterised statement, joined into one string to match against. */
async function explainPlan(sql: string, params: unknown[]): Promise<string> {
  const result = await query<{ info: string }>(`EXPLAIN ${sql}`, params)
  return result.rows.map((r) => r.info).join('\n')
}

describe.skipIf(!LIVE)('CockroachDB memory layer', () => {
  beforeAll(async () => {
    await resetPackage(PKG)
    await resetPackage(OTHER_PKG)

    await seedEvent('commit', 'small portability fix to the decoder', '2022-01-01T00:00:00Z')
    await seedEvent('commit', 'reworks the autoconf build system and CI matrix', '2022-06-01T00:00:00Z')
    await seedEvent('maintainer_change', 'named as co-maintainer with commit access', '2022-08-01T00:00:00Z')
    await seedEvent('release', 'publishes the 5.6.0 release tarball', '2024-02-24T00:00:00Z')
    // A second package, so "prefix-scoped" is a claim with something to exclude.
    await seedEvent('commit', 'unrelated work in a different package entirely', '2023-01-01T00:00:00Z', OTHER_PKG)

    for (const [label, text] of [
      ['takeover', 'A contributor with no prior history takes over release engineering after pressure accounts push the maintainer out.'],
      ['benign', 'A long-standing contributor gradually takes on more review work and is eventually made a co-maintainer.'],
    ] as const) {
      playbookIds.push(
        await insertPlaybookArc(
          { packageId: `${PKG}-${label}`, label, source: 'synthetic', heldOut: false, arcSummary: text },
          offlineEmbed(text),
        ),
      )
    }
    const heldText = 'A held-out arc that must never be returned by the agent.'
    playbookIds.push(
      await insertPlaybookArc(
        { packageId: `${PKG}-held`, label: 'takeover', source: 'synthetic', heldOut: true, arcSummary: heldText },
        offlineEmbed(heldText),
      ),
    )
  }, 60_000)

  afterAll(async () => {
    await resetPackage(PKG)
    await resetPackage(OTHER_PKG)
    await resetPackage(ONLY_CITING)
    await resetPackage(ALSO_UNCITED)
    await resetPackage(UNMARKED_HELD)
    await query('DELETE FROM trust_state WHERE package_id = ANY($1)', [
      [PKG, OTHER_PKG, ONLY_CITING, ALSO_UNCITED, UNMARKED_HELD],
    ])
    if (playbookIds.length) {
      await query('DELETE FROM takeover_playbook WHERE id = ANY($1)', [playbookIds])
    }
    await closePool()
  })

  it('has every table the architecture calls for', async () => {
    const result = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    )
    const tables = result.rows.map((r) => r.table_name)
    for (const t of [
      'events',
      'actor_arcs',
      'takeover_playbook',
      'release_hold',
      'trust_state',
      'distro_advisory_outbox',
      'audit_log',
    ]) {
      expect(tables).toContain(t)
    }
  })

  it('declares a vector index on every table that is searched by vector', async () => {
    const result = await query<{ index_name: string }>(
      `SELECT index_name FROM [SHOW INDEXES FROM events]
       UNION SELECT index_name FROM [SHOW INDEXES FROM actor_arcs]
       UNION SELECT index_name FROM [SHOW INDEXES FROM takeover_playbook]`,
    )
    const names = result.rows.map((r) => r.index_name)
    expect(names).toContain('events_pkg_embedding_idx')
    expect(names).toContain('actor_arcs_pkg_embedding_idx')
    expect(names).toContain('takeover_playbook_embedding_idx')
  })

  // Every read this system makes on a hot path is either a vector search or a time-ordered history
  // read, and for a long time only the first kind had an index. A missing secondary index does not
  // fail a test, it just makes the whole thing quietly O(everything ever recorded).
  it('indexes the non-vector reads too, instead of full-scanning history', async () => {
    const result = await query<{ index_name: string }>(
      `SELECT index_name FROM [SHOW INDEXES FROM events]
       UNION SELECT index_name FROM [SHOW INDEXES FROM actor_arcs]
       UNION SELECT index_name FROM [SHOW INDEXES FROM release_hold]
       UNION SELECT index_name FROM [SHOW INDEXES FROM distro_advisory_outbox]
       UNION SELECT index_name FROM [SHOW INDEXES FROM audit_log]`,
    )
    const names = result.rows.map((r) => r.index_name)
    for (const idx of [
      'events_pkg_actor_time_idx',
      'events_pkg_time_idx',
      'events_event_key_idx',
      'actor_arcs_pkg_actor_key',
      'release_hold_pkg_time_idx',
      // CockroachDB does not index a FK's referencing column for you, and the whole evidence read
      // looks rows up by exactly these two.
      'advisory_hold_idx',
      'audit_hold_idx',
    ]) {
      expect(names).toContain(idx)
    }
  })

  // `label` is read back through an `as Label` cast, and a TypeScript cast cannot fail. A row
  // labelled 'Takeover' would match neither side of the two-sided gate, so the margin would
  // collapse and the hold would silently not fire. Only the database can catch this.
  it('refuses values outside the closed sets the decision logic assumes', async () => {
    const vector = `[${offlineEmbed('constraint probe').join(',')}]`

    await expect(
      query(
        `INSERT INTO takeover_playbook
           (package_id, label, source, held_out, arc_summary, embedding, embedding_model, embedding_dims)
         VALUES ($1, 'Takeover', 'synthetic', false, 'x', $2::VECTOR, 'test', 1024)`,
        [`${PKG}-bad-label`, vector],
      ),
    ).rejects.toThrow(/check constraint|violates/i)

    // Same argument for `kind`: src/signals.ts counts these by exact string, so an unknown kind
    // would be counted as none of them and silently shrink every ratio the arc is built from.
    await expect(
      query(
        `INSERT INTO events
           (package_id, actor_id, kind, content, occurred_at, event_key, embedding,
            embedding_model, embedding_dims)
         VALUES ($1, 'a', 'pull_request', 'x', now(), $2, $3::VECTOR, 'test', 1024)`,
        [`${PKG}-bad-kind`, `${PKG}-bad-kind-key`, vector],
      ),
    ).rejects.toThrow(/check constraint|violates/i)

    await expect(
      query(`INSERT INTO trust_state (package_id, status) VALUES ($1, 'quarantined')`, [
        `${PKG}-bad-status`,
      ]),
    ).rejects.toThrow(/check constraint|violates/i)
  })

  it('reads an actor’s history back out of the cluster in order', async () => {
    const history = await actorHistory(PKG, ACTOR, ASOF)
    expect(history).toHaveLength(4)
    expect(history.map((e) => e.kind)).toEqual(['commit', 'commit', 'maintainer_change', 'release'])
  })

  it('never lets a decision see events from after its assessment point', async () => {
    const history = await actorHistory(PKG, ACTOR, new Date('2022-07-01T00:00:00Z'))
    expect(history).toHaveLength(2)
  })

  // API Gateway and Lambda both retry a delivery whose response they did not see, and a judge
  // re-runs the replay. A duplicated maintainer_change is not a cosmetic extra row: every ratio in
  // src/signals.ts is computed over these rows, so it moves the arc the hold decision is made on.
  it('is idempotent on a redelivered webhook — same id, no second row', async () => {
    const input = {
      packageId: PKG,
      actorId: ACTOR,
      kind: 'maintainer_change',
      content: 'named as co-maintainer with commit access',
      occurredAt: '2022-08-01T00:00:00Z',
    }
    const first = await ingestEvent(input, offlineEmbed(input.content))
    // Redelivered with the timestamp formatted differently and a citation attached, which is what
    // a second delivery path actually looks like.
    const second = await ingestEvent(
      { ...input, occurredAt: '2022-08-01T00:00:00.000+00:00', sourceUrl: 'https://example.invalid' },
      offlineEmbed(input.content),
    )
    expect(second).toBe(first)

    const rows = await query<{ n: string }>(
      `SELECT count(*) AS n FROM events
       WHERE package_id = $1 AND actor_id = $2 AND kind = 'maintainer_change'`,
      [PKG, ACTOR],
    )
    expect(Number(rows.rows[0]!.n)).toBe(1)
    expect(await actorHistory(PKG, ACTOR, ASOF)).toHaveLength(4)
  })

  it('records which model produced every stored vector', async () => {
    const rows = await query<{ embedding_model: string; embedding_dims: number }>(
      'SELECT embedding_model, embedding_dims FROM events WHERE package_id = $1 LIMIT 1',
      [PKG],
    )
    expect(rows.rows[0]!.embedding_model).toBe(OFFLINE_EMBEDDING_MODEL)
    expect(Number(rows.rows[0]!.embedding_dims)).toBe(1024)
  })

  it('scopes ANN retrieval to one package’s own memory', async () => {
    const neighbours = await scopedNeighbours(PKG, offlineEmbed('build system changes'), 20)
    expect(neighbours.length).toBeGreaterThan(0)
    expect(neighbours.every((n) => n.packageId === PKG)).toBe(true)
  })

  /**
   * The README claims a corpus written by a different embedding model "cannot be searched at all
   * rather than silently returning meaningless neighbours". That was true of `takeover_playbook`,
   * where the model id is an index prefix column, and false of `events`, which stored the model
   * and never filtered on it — so a cluster holding offline vectors that a Bedrock run later
   * extended would serve cross-model neighbours to `/api/explain` as retrieval evidence.
   *
   * The row is inserted through raw SQL because there is no way to reach this state through
   * `ingestEvent`: it stamps whatever model the process is running. Which is the point — the state
   * arrives from a SECOND process, embedding the same package with a different model.
   */
  it('never returns a neighbour embedded by a different model', async () => {
    const content = 'reworks the autoconf build system and CI matrix'
    const foreignKey = `${PKG}-foreign-model-key`
    await query(
      `INSERT INTO events
         (package_id, actor_id, kind, content, occurred_at, event_key, embedding,
          embedding_model, embedding_dims)
       VALUES ($1, $2, 'commit', $3, '2022-06-02T00:00:00Z', $4, $5::VECTOR, $6, 1024)`,
      [PKG, ACTOR, content, foreignKey, `[${offlineEmbed(content).join(',')}]`, 'some-other-model-1024'],
    )

    try {
      // Embedded from the same text as a real row, so it is a *nearest* neighbour by construction:
      // if the filter were missing this would sit at or near the top of the panel.
      const neighbours = await scopedNeighbours(PKG, offlineEmbed(content), 20)
      expect(neighbours.length).toBeGreaterThan(0)
      const ids = neighbours.map((n) => n.id)
      const foreign = await query<{ id: string }>('SELECT id FROM events WHERE event_key = $1', [
        foreignKey,
      ])
      expect(ids).not.toContain(foreign.rows[0]!.id)

      const models = await query<{ embedding_model: string }>(
        'SELECT DISTINCT embedding_model FROM events WHERE id = ANY($1::UUID[])',
        [ids],
      )
      expect(models.rows.map((r) => r.embedding_model)).toEqual([OFFLINE_EMBEDDING_MODEL])

      // The filter must not have cost the plan. `events` cannot pre-filter on the model — it is not
      // an index prefix column there — so the guarantee is "never returned", not "never descended
      // into", and the vector search itself has to stay exactly as scoped as it was.
      const explain = await explainScoped(PKG, offlineEmbed(content))
      expect(explain.usedVectorIndex).toBe(true)
      expect(explain.prefixScoped).toBe(true)
    } finally {
      await query('DELETE FROM events WHERE event_key = $1', [foreignKey])
    }
  })

  it('proves prefix scoping through EXPLAIN — the claim the demo makes on camera', async () => {
    const explain = await explainScoped(PKG, offlineEmbed('build system changes'))
    expect(explain.usedVectorIndex).toBe(true)
    expect(explain.prefixScoped).toBe(true)
    expect(explain.plan).toMatch(/prefix spans:/i)
    expect(explain.plan).toContain(PKG)
  })

  // The test above proves scoping on the query that feeds a UI panel. This one proves it on the
  // query that decides whether a release is held — which is the one a judge should care about, and
  // which for a long time had never been EXPLAINed at all. With `held_out` outside the index, the
  // filter runs AFTER the k candidates are chosen, so held-out arcs eat top-k slots; `decide()`
  // needs both a takeover and a benign neighbour, so a one-sided result silently suppresses a hold.
  it('proves the DECIDING query is prefix-scoped too, not just the one on screen', async () => {
    const explain = await explainPlaybook(offlineEmbed('takeover of release engineering'), 5)
    expect(explain.usedVectorIndex).toBe(true)
    expect(explain.prefixScoped).toBe(true)
    expect(explain.plan).toMatch(/prefix spans:/i)
    // held_out=false is the leading prefix column; the model id is the second.
    expect(explain.plan).toMatch(/prefix spans: \[\/false/i)
    expect(explain.plan).toContain(OFFLINE_EMBEDDING_MODEL)
  })

  /**
   * The two tests above are about the retrieval. This one is about the reads that feed it.
   *
   * `actorHistory` and `packageHistory` run on every assessment, and sql/schema.sql calls them the
   * one access pattern this project cannot afford to be slow at. Having an index they can scan is
   * not the same as being served by it: with only the key columns indexed, CockroachDB found the
   * rows in `events_pkg_*_time_idx` and then ran an `index join` back into `events@events_pkey` to
   * fetch kind, content and source_url — up to SLEEPER_HISTORY_LIMIT (5,000) primary-key lookups
   * per assessment, for rows it had already located. The STORING lists make both reads covering.
   *
   * Asserted as the ABSENCE of `index join`, because that is the failure: any future column added
   * to either SELECT list without being added to the STORING list brings the lookup straight back,
   * and nothing else in the suite would notice. The positive assertion on the index name is what
   * keeps the negative one honest — a plan that stopped using these indexes altogether would
   * otherwise pass by having no join to find.
   */
  it('serves both history reads from a covering index, with no lookup back into the table', async () => {
    const actorPlan = await explainPlan(ACTOR_HISTORY_SQL, [PKG, ACTOR, ASOF.toISOString(), HISTORY_LIMIT])
    expect(actorPlan).toContain('events@events_pkg_actor_time_idx')
    expect(actorPlan).not.toMatch(/index join/i)
    expect(actorPlan).not.toContain('events@events_pkey')

    const packagePlan = await explainPlan(PACKAGE_HISTORY_SQL, [PKG, ASOF.toISOString(), HISTORY_LIMIT])
    expect(packagePlan).toContain('events@events_pkg_time_idx')
    expect(packagePlan).not.toMatch(/index join/i)
    expect(packagePlan).not.toContain('events@events_pkey')
  })

  it('returns similarities in [-1, 1] and in descending order', async () => {
    const neighbours = await scopedNeighbours(PKG, offlineEmbed('build system changes'), 4)
    for (const n of neighbours) {
      expect(n.similarity).toBeGreaterThanOrEqual(-1)
      expect(n.similarity).toBeLessThanOrEqual(1)
    }
    const sims = neighbours.map((n) => n.similarity)
    expect([...sims].sort((a, b) => b - a)).toEqual(sims)
  })

  it('excludes held-out arcs from every retrieval the agent runs', async () => {
    const matches = await matchPlaybook(offlineEmbed('a held-out arc that must never be returned'), 50)
    expect(matches.some((m) => m.packageId === `${PKG}-held`)).toBe(false)
  })

  it('supports leave-one-out so calibration cannot let an arc match itself', async () => {
    const target = playbookIds[0]!
    const all = await matchPlaybook(offlineEmbed('takeover of release engineering'), 50)
    expect(all.some((m) => m.id === target)).toBe(true)
    const loo = await matchPlaybook(offlineEmbed('takeover of release engineering'), 50, target)
    expect(loo.some((m) => m.id === target)).toBe(false)
  })

  it('keeps exactly one rolling arc row per actor', async () => {
    const summary = 'first version of the arc'
    await upsertActorArc(PKG, ACTOR, arcWindow(ASOF, 90, 2), summary, offlineEmbed(summary))
    const second = 'second version of the arc'
    await upsertActorArc(PKG, ACTOR, arcWindow(ASOF, 90, 3), second, offlineEmbed(second))

    const rows = await query<{ n: string }>(
      'SELECT count(*) AS n FROM actor_arcs WHERE package_id = $1 AND actor_id = $2',
      [PKG, ACTOR],
    )
    expect(Number(rows.rows[0]!.n)).toBe(1)

    const stored = await loadActorArc(PKG, ACTOR)
    expect(stored?.arcSummary).toBe(second)
    expect(stored?.embedding).toHaveLength(1024)
  })

  // The old DELETE-then-INSERT pair had no transaction and no unique constraint, so two
  // assessments of one actor racing each other — a webhook and a replay, which is the normal case
  // — could both delete and then both insert, leaving two arc rows. `loadActorArc`'s LIMIT 1 then
  // returns whichever the cluster feels like.
  it('keeps that invariant under concurrent assessments of the same actor', async () => {
    const summaries = ['race arc alpha', 'race arc beta', 'race arc gamma', 'race arc delta']
    await Promise.all(
      summaries.map((s, i) =>
        upsertActorArc(PKG, ACTOR, arcWindow(ASOF, 90, i), s, offlineEmbed(s)),
      ),
    )

    const rows = await query<{ n: string }>(
      'SELECT count(*) AS n FROM actor_arcs WHERE package_id = $1 AND actor_id = $2',
      [PKG, ACTOR],
    )
    expect(Number(rows.rows[0]!.n)).toBe(1)

    // Whichever writer landed last, the surviving row is one of the four — never a blend and
    // never absent.
    const stored = await loadActorArc(PKG, ACTOR)
    expect(summaries).toContain(stored?.arcSummary)
  })

  it('commits a hold as one transaction and exposes the whole evidence trail', async () => {
    const result = await commitHold({
      packageId: PKG,
      releaseVersion: '5.6.0',
      reason: 'behavioural arc matches a known takeover shape',
      matchedPlaybookId: playbookIds[0]!,
      similarity: 0.87,
      advisoryText: 'Hold 5.6.0 pending review.',
      auditDetail: 'similarity 0.87 | prefix-scoped true',
    })

    expect(result.writes).toHaveLength(4)

    const evidence = await holdEvidence(result.holdId)
    expect(evidence).not.toBeNull()
    expect(evidence!.hold.releaseVersion).toBe('5.6.0')
    expect(evidence!.hold.similarity).toBeCloseTo(0.87)
    expect(evidence!.trustStatus).toBe('held')
    expect(evidence!.advisories).toHaveLength(1)
    expect(evidence!.auditTrail).toHaveLength(1)
    expect(evidence!.matchedArc?.label).toBe('takeover')
  })

  // A behavioural gate WILL produce false positives. sql/schema.sql advertised a 'cleared' status
  // that no code path ever wrote, so the first one blocked a package's releases forever with an
  // advisory already queued to Debian/Fedora/Arch and nothing on record withdrawing it.
  it('can clear a hold — atomically, and without deleting the hold it is retracting', async () => {
    const hold = await commitHold({
      packageId: PKG,
      releaseVersion: '5.6.1',
      reason: 'behavioural arc matches a known takeover shape',
      matchedPlaybookId: playbookIds[0]!,
      similarity: 0.81,
      advisoryText: 'Hold 5.6.1 pending review.',
      auditDetail: 'similarity 0.81',
    })

    const result = await commitUnhold(hold.holdId, 'maintainer@example.invalid', 'Reviewed: the account is a long-standing contributor on a new machine.')
    expect(result.writes).toHaveLength(4)
    // One package can be held by more than one release. The 5.6.0 hold from the previous test is
    // still open, so clearing this one must NOT un-hold the package.
    expect(result.trustStatus).toBe('held')

    const evidence = await holdEvidence(hold.holdId)
    // The hold row survives, annotated. The paper trail is append-only: "we held your release and
    // then erased the evidence" is worse than the false positive it would be covering up.
    expect(evidence).not.toBeNull()
    expect(evidence!.hold.releaseVersion).toBe('5.6.1')
    expect(evidence!.hold.resolution).toBe('cleared')
    expect(evidence!.hold.resolvedBy).toBe('maintainer@example.invalid')
    expect(evidence!.hold.resolvedAt).toBeInstanceOf(Date)
    expect(evidence!.trustStatus).toBe('held')
    // The retraction is a NEW advisory, not an edit: the first one may already have been sent.
    expect(evidence!.advisories).toHaveLength(2)
    expect(evidence!.advisories[1]!.advisoryText).toMatch(/RETRACTION/)
    expect(evidence!.auditTrail.map((a) => a.action)).toEqual(['hold', 'unhold'])
  })

  it('returns the package to trusted only once the LAST open hold is cleared', async () => {
    const open = await query<{ id: string }>(
      'SELECT id FROM release_hold WHERE package_id = $1 AND resolution IS NULL',
      [PKG],
    )
    expect(open.rows.length).toBeGreaterThan(0)
    for (const row of open.rows) {
      await commitUnhold(row.id, 'maintainer@example.invalid', 'cleared with the 5.6.1 review')
    }
    const trust = await query<{ status: string }>(
      'SELECT status FROM trust_state WHERE package_id = $1',
      [PKG],
    )
    expect(trust.rows[0]!.status).toBe('cleared')
  })

  it('records a resolution once and refuses to overwrite it', async () => {
    const holds = await query<{ id: string }>(
      `SELECT id FROM release_hold WHERE package_id = $1 AND release_version = '5.6.1' LIMIT 1`,
      [PKG],
    )
    await expect(
      commitUnhold(holds.rows[0]!.id, 'someone-else', 'second opinion'),
    ).rejects.toThrow(/already resolved/)

    // …and the refusal left nothing behind: still exactly two advisories and two audit rows.
    const evidence = await holdEvidence(holds.rows[0]!.id)
    expect(evidence!.advisories).toHaveLength(2)
    expect(evidence!.auditTrail).toHaveLength(2)
  })

  // The unhold is four writes in one COMMIT exactly like the hold, and it is the harder half to
  // check: it runs after a human has already been told the hold was a false positive. A clear that
  // half-lands — resolution recorded, retraction never queued — leaves Debian, Fedora and Arch
  // holding an advisory for a hold that, as far as the cluster is concerned, no longer exists.
  it('leaves no partial state when an unhold fails mid-transaction', async () => {
    const hold = await commitHold({
      packageId: PKG,
      releaseVersion: '5.6.2',
      reason: 'behavioural arc matches a known takeover shape',
      matchedPlaybookId: playbookIds[0]!,
      similarity: 0.79,
      advisoryText: 'Hold 5.6.2 pending review.',
      auditDetail: 'similarity 0.79',
    })

    // The failure is injected the way one would actually arrive: an unauthenticated caller identity
    // threaded through to `resolvedBy`. It survives the UPDATE, the trust_state flip and the
    // retraction advisory, and is rejected by `audit_log.actor NOT NULL` — i.e. at the LAST of the
    // four writes, which is the only ordering that can prove the first three were undone.
    await expect(
      commitUnhold(hold.holdId, null as unknown as string, 'cleared by a caller with no identity'),
      // Matched precisely so this cannot start passing for some unrelated reason: SQLSTATE 23502,
      // raised by the cluster on the fourth write, not by validation before the first.
    ).rejects.toThrow(/null value in column "actor"/)

    const evidence = await holdEvidence(hold.holdId)
    expect(evidence).not.toBeNull()
    expect(evidence!.hold.resolution).toBeNull()
    expect(evidence!.hold.resolvedBy).toBeNull()
    expect(evidence!.hold.resolvedAt).toBeNull()
    // Every other hold on this package was cleared by the test above, so a trust_state write that
    // had survived the rollback would read 'cleared' here — this assertion is the one that would
    // catch it.
    expect(evidence!.trustStatus).toBe('held')
    expect(evidence!.advisories).toHaveLength(1)
    expect(evidence!.advisories[0]!.advisoryText).not.toMatch(/RETRACTION/)
    expect(evidence!.auditTrail.map((a) => a.action)).toEqual(['hold'])
  })

  it('refuses to clear the playbook while holds cite it, instead of deleting their audit trail', async () => {
    const before = await query<{ n: string }>('SELECT count(*) AS n FROM audit_log')

    // `npm run seed` used to run four unscoped DELETEs — audit_log first — so a reseed erased
    // every hold, advisory and audit row for every package in the cluster.
    await expect(clearPlaybook()).rejects.toThrow(/Refusing to clear the playbook/)

    const after = await query<{ n: string }>('SELECT count(*) AS n FROM audit_log')
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n)
    const arcs = await playbookArcs(false)
    expect(arcs.length).toBeGreaterThan(0)
  })

  it('leaves no partial state when a hold fails mid-transaction', async () => {
    const before = await query<{ n: string }>(
      'SELECT count(*) AS n FROM release_hold WHERE package_id = $1',
      [PKG],
    )

    await expect(
      withTransaction(async (client) => {
        const hold = await client.query<{ id: string }>(
          `INSERT INTO release_hold (package_id, release_version, reason, matched_playbook_id, similarity)
           VALUES ($1, '9.9.9', 'should never survive', $2, 0.99) RETURNING id`,
          [PKG, playbookIds[0]!],
        )
        await client.query(
          `INSERT INTO distro_advisory_outbox (release_hold_id, advisory_text) VALUES ($1, 'orphan')`,
          [hold.rows[0]!.id],
        )
        // Whatever goes wrong — a Bedrock timeout composing the advisory, the Lambda being killed —
        // the release must not end up blocked with a half-written paper trail.
        throw new Error('simulated failure after the first writes')
      }),
    ).rejects.toThrow(/simulated failure/)

    const after = await query<{ n: string }>(
      'SELECT count(*) AS n FROM release_hold WHERE package_id = $1',
      [PKG],
    )
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n)

    const orphans = await query<{ n: string }>(
      `SELECT count(*) AS n FROM distro_advisory_outbox WHERE advisory_text = 'orphan'`,
    )
    expect(Number(orphans.rows[0]!.n)).toBe(0)
  })

  it('reads playbook arcs back with their vectors intact', async () => {
    const arcs = await playbookArcs(false)
    const mine = arcs.filter((a) => a.packageId.startsWith(PKG))
    expect(mine.length).toBe(2)
    for (const arc of mine) {
      expect(arc.embedding).toHaveLength(1024)
      expect(Math.hypot(...arc.embedding)).toBeCloseTo(1, 4)
    }
  })

  it('resets a package back to a clean, trusted state', async () => {
    await resetPackage(PKG)
    const events = await query<{ n: string }>('SELECT count(*) AS n FROM events WHERE package_id = $1', [PKG])
    const arcs = await query<{ n: string }>('SELECT count(*) AS n FROM actor_arcs WHERE package_id = $1', [PKG])
    const trust = await query<{ status: string }>('SELECT status FROM trust_state WHERE package_id = $1', [PKG])
    expect(Number(events.rows[0]!.n)).toBe(0)
    expect(Number(arcs.rows[0]!.n)).toBe(0)
    expect(trust.rows[0]!.status).toBe('trusted')
  })

  it('leaves other packages untouched when one is reset', async () => {
    const other = await query<{ n: string }>('SELECT count(*) AS n FROM events WHERE package_id = $1', [OTHER_PKG])
    expect(Number(other.rows[0]!.n)).toBe(1)
  })

  /**
   * Runs LAST — with the invariant check below it — because it executes the one genuinely
   * destructive statement in the codebase. See `snapshotForeignRows` for what that costs and why
   * the suite is still safe to point at the demo's own cluster.
   */
  it('clears the corpus without taking an unrelated package’s paper trail with it', async () => {
    const mine = [PKG, OTHER_PKG]
    const foreign = await snapshotForeignRows(playbookIds, mine)

    try {
      // One hold that CITES the corpus — the only kind the foreign key forces out — and one that
      // does not, on a different package. The second is the one the old unscoped `DELETE FROM
      // audit_log` destroyed for no reason at all.
      const citing = await commitHold({
        packageId: PKG,
        releaseVersion: '5.7.0',
        reason: 'behavioural arc matches a known takeover shape',
        matchedPlaybookId: playbookIds[0]!,
        similarity: 0.9,
        advisoryText: 'Hold 5.7.0 pending review.',
        auditDetail: 'cites the corpus, so the FK forces it out on a forced clear',
      })
      const unrelated = await commitHold({
        packageId: OTHER_PKG,
        releaseVersion: '2.0.0',
        reason: 'held on signals alone, with no matching playbook arc',
        matchedPlaybookId: null,
        similarity: 0.42,
        advisoryText: 'Hold 2.0.0 pending review.',
        auditDetail: 'cites nothing in the corpus and must survive a reseed',
      })

      // Consent first: even the holds the FK would force out are refused by default, because
      // "your reseed is about to delete N holds" should be a decision, not a side effect.
      await expect(clearPlaybook()).rejects.toThrow(/Refusing to clear the playbook/)
      // …and the refusal is total: the corpus is still there, so nothing half-cleared.
      expect((await playbookArcs(false)).length).toBeGreaterThan(0)
      expect(await holdEvidence(citing.holdId)).not.toBeNull()

      // The escape hatch. `npm run seed` reaches it via SLEEPER_FORCE_CLEAR=1.
      await clearPlaybook({ force: true })

      const emptied = await query<{ n: string }>('SELECT count(*) AS n FROM takeover_playbook')
      expect(Number(emptied.rows[0]!.n)).toBe(0)

      // The citing hold went with the corpus — with its advisory and its audit rows, which is what
      // the foreign key forces and what the refusal above exists to make you agree to first.
      expect(await holdEvidence(citing.holdId)).toBeNull()
      const orphanRows = await query<{ n: string }>(
        `SELECT (SELECT count(*) FROM distro_advisory_outbox WHERE release_hold_id = $1)
              + (SELECT count(*) FROM audit_log WHERE release_hold_id = $1) AS n`,
        [citing.holdId],
      )
      expect(Number(orphanRows.rows[0]!.n)).toBe(0)

      // The unrelated package's hold is untouched — row, advisory and audit trail. This is the
      // regression: the old version deleted all three for every package in the cluster.
      const survivor = await holdEvidence(unrelated.holdId)
      expect(survivor).not.toBeNull()
      expect(survivor!.hold.packageId).toBe(OTHER_PKG)
      expect(survivor!.hold.releaseVersion).toBe('2.0.0')
      expect(survivor!.advisories).toHaveLength(1)
      expect(survivor!.auditTrail).toEqual([
        expect.objectContaining({ actor: 'agent', action: 'hold' }),
      ])
    } finally {
      await restoreForeignRows(foreign)
    }

    // The restore is asserted, not assumed: a silent partial restore would leave the next person's
    // demo half-seeded and blame the seed script.
    const restored = await query<{ n: string }>('SELECT count(*) AS n FROM takeover_playbook')
    expect(Number(restored.rows[0]!.n)).toBe(foreign.arcs.length)
    const holdsBack = await query<{ n: string }>(
      'SELECT count(*) AS n FROM release_hold WHERE NOT (package_id = ANY($1))',
      [mine],
    )
    expect(Number(holdsBack.rows[0]!.n)).toBe(foreign.holds.length)
  })

  /**
   * The invariant `trust_state` exists to carry: a package is 'held' if and only if a hold is open
   * on it.
   *
   * `clearPlaybook` broke it, and broke it on the routine path — `npm run seed` — because
   * `trust_state` has no foreign key to `release_hold` and was written in exactly three places,
   * none of them here. The observed result on the demo cluster was `trust_state` saying
   * `xz-utils | held` with zero rows in `release_hold`, and `/api/state` answering
   * `"trustStatus":"held","latestHold":null`: a package that claims to be held and can produce no
   * hold to show for it. `resetPackage` already names that as the single most damaging state this
   * UI can be in; the seed path was walking straight into it.
   *
   * Asserted as an invariant over the whole cluster rather than as an equality on one package,
   * because the failure is not "this package has the wrong status" — it is "some package somewhere
   * is lying about being held", and the next one to do it will not be xz-utils.
   *
   * BOTH directions are asserted. "If and only if" was only ever checked left-to-right, and the
   * missing half showed up on the demo cluster in exactly the way an untested invariant does: an
   * open hold on a package reading 'trusted'. See `heldPackagesNotMarked` for why that one is the
   * quieter and more dangerous of the two.
   */
  it('never leaves a package held with no open hold — after a clear, or at all', async () => {
    // Two packages, because the interesting half is what must NOT change. `commitUnhold` already
    // makes the trust status follow the REMAINING open holds rather than the one being resolved,
    // and a clear has to reach the same answer by the same rule.
    const arcText = 'A synthetic arc that exists only to be cited by the holds in this test.'
    const foreign = await snapshotForeignRows([], [PKG, OTHER_PKG, ONLY_CITING, ALSO_UNCITED])

    try {
      const arcId = await insertPlaybookArc(
        { packageId: `${PKG}-clear-arc`, label: 'takeover', source: 'synthetic', heldOut: false, arcSummary: arcText },
        offlineEmbed(arcText),
      )
      playbookIds.push(arcId)

      // The package whose ONLY open hold cites the corpus: the clear takes its last justification
      // away, so its status must follow.
      await commitHold({
        packageId: ONLY_CITING,
        releaseVersion: '1.0.0',
        reason: 'behavioural arc matches a known takeover shape',
        matchedPlaybookId: arcId,
        similarity: 0.88,
        advisoryText: 'Hold 1.0.0 pending review.',
        auditDetail: 'the only hold on this package, and it cites the corpus',
      })
      // The package that keeps a hold the foreign key does not touch: it is still legitimately held
      // after the clear, and resetting it would be its own kind of lie.
      await commitHold({
        packageId: ALSO_UNCITED,
        releaseVersion: '2.0.0',
        reason: 'behavioural arc matches a known takeover shape',
        matchedPlaybookId: arcId,
        similarity: 0.84,
        advisoryText: 'Hold 2.0.0 pending review.',
        auditDetail: 'cites the corpus and will be deleted',
      })
      await commitHold({
        packageId: ALSO_UNCITED,
        releaseVersion: '2.0.1',
        reason: 'held on signals alone, with no matching playbook arc',
        matchedPlaybookId: null,
        similarity: 0.41,
        advisoryText: 'Hold 2.0.1 pending review.',
        auditDetail: 'cites nothing, so it survives the clear and keeps the package held',
      })

      const statusOf = async (pkg: string): Promise<string | null> => {
        const r = await query<{ status: string }>('SELECT status FROM trust_state WHERE package_id = $1', [pkg])
        return r.rows[0]?.status ?? null
      }
      const openHolds = async (pkg: string): Promise<number> => {
        const r = await query<{ n: string }>(
          'SELECT count(*) AS n FROM release_hold WHERE package_id = $1 AND resolution IS NULL',
          [pkg],
        )
        return Number(r.rows[0]!.n)
      }

      expect(await statusOf(ONLY_CITING)).toBe('held')
      expect(await statusOf(ALSO_UNCITED)).toBe('held')

      await clearPlaybook({ force: true })

      // Its hold is gone, so the claim goes with it. 'trusted' rather than 'cleared': nobody
      // reviewed anything, the evidence was deleted by a reseed — the same wording `resetPackage`
      // uses for the same reason.
      expect(await openHolds(ONLY_CITING)).toBe(0)
      expect(await statusOf(ONLY_CITING)).toBe('trusted')

      // One hold survived, so the package is still held — and still able to show why.
      expect(await openHolds(ALSO_UNCITED)).toBe(1)
      expect(await statusOf(ALSO_UNCITED)).toBe('held')

      expect(await orphanedHeldPackages()).toEqual([])
      // ALSO_UNCITED is the live proof for this direction rather than a hypothetical: it is holding
      // an open hold the clear did not touch, so if the clear had reset its status — or reset one
      // package too many — this is what would catch it.
      expect(await heldPackagesNotMarked()).toEqual([])
    } finally {
      await restoreForeignRows(foreign)
      await resetPackage(ONLY_CITING)
      await resetPackage(ALSO_UNCITED)
    }

    // The restore has to land the cluster back on BOTH invariants, not just back on its rows. It
    // puts foreign holds back after the clear reset the statuses that justified them, so restoring
    // the holds alone is precisely how an open hold ends up on a package reading 'trusted'.
    expect(await orphanedHeldPackages()).toEqual([])
    expect(await heldPackagesNotMarked()).toEqual([])
  })

  /**
   * Proof that the check above can fail — an invariant assertion nobody has ever seen go red is a
   * comment with a green tick next to it.
   *
   * The violation is built the way the real one arrives: not by inventing an impossible row, but by
   * writing `trust_state` without consulting `release_hold`, which is what every path that touches
   * this table is one refactor away from doing. Scoped to a package this suite owns, and torn down
   * whatever happens — the cluster-wide assertions are the point, and they run before this.
   */
  it('detects an open hold whose package is not marked held — the inverse the old check missed', async () => {
    const hold = await commitHold({
      packageId: UNMARKED_HELD,
      releaseVersion: '3.0.0',
      reason: 'held on signals alone, with no matching playbook arc',
      matchedPlaybookId: null,
      similarity: 0.55,
      advisoryText: 'Hold 3.0.0 pending review.',
      auditDetail: 'exists so the inverse invariant has something to catch',
    })

    try {
      // `commitHold` writes both halves in one transaction, so nothing is wrong yet.
      expect(await heldPackagesNotMarked()).not.toContain(UNMARKED_HELD)

      await query(`UPDATE trust_state SET status = 'trusted', updated_at = now() WHERE package_id = $1`, [
        UNMARKED_HELD,
      ])

      expect(await heldPackagesNotMarked()).toContain(UNMARKED_HELD)
      // …and the original check is blind to it, which is the whole reason this one exists: the
      // package no longer claims to be held, so there is no orphaned claim to find.
      expect(await orphanedHeldPackages()).not.toContain(UNMARKED_HELD)

      // A missing row is a violation too — `/api/state` reads absence as trusted, so deleting the
      // status is the same lie as rewriting it.
      await query('DELETE FROM trust_state WHERE package_id = $1', [UNMARKED_HELD])
      expect(await heldPackagesNotMarked()).toContain(UNMARKED_HELD)

      // Resolving the hold ends the violation without anyone touching trust_state again: the
      // invariant is about OPEN holds, and a resolved one makes no claim on the status.
      await commitUnhold(hold.holdId, 'maintainer@example.invalid', 'Reviewed: no takeover pattern.')
      expect(await heldPackagesNotMarked()).not.toContain(UNMARKED_HELD)
    } finally {
      await resetPackage(UNMARKED_HELD)
    }

    expect(await heldPackagesNotMarked()).toEqual([])
    expect(await orphanedHeldPackages()).toEqual([])
  })
})
