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
  OFFLINE_EMBEDDING_MODEL,
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
const ACTOR = 'test-actor'
const ASOF = new Date('2024-02-24T00:00:00Z')

const playbookIds: string[] = []

async function seedEvent(kind: string, content: string, occurredAt: string, pkg = PKG): Promise<string> {
  return ingestEvent(
    { packageId: pkg, actorId: ACTOR, kind, content, occurredAt },
    offlineEmbed(content),
  )
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
    await query('DELETE FROM trust_state WHERE package_id = ANY($1)', [[PKG, OTHER_PKG]])
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
   * Runs LAST, because it executes the one genuinely destructive statement in the codebase.
   *
   * `clearPlaybook` has no package scope and cannot have one — the corpus is global by design, that
   * is the whole point of matching a shape learned in one ecosystem from another package. So the
   * forced path deletes every playbook row in the cluster and, with it, every hold that cites one.
   * DEMO.md tells a judge to point this suite at the same cluster the demo runs on, so the test
   * snapshots every row it does not own and puts it back afterwards, ids included. A test that ate
   * the demo's hold in order to prove that holds are safe would be a poor joke.
   */
  it('clears the corpus without taking an unrelated package’s paper trail with it', async () => {
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

    const mine = [PKG, OTHER_PKG]
    const foreignArcs = await query<ArcRow>(
      `SELECT id, package_id, label, source, held_out, arc_summary, embedding::STRING AS embedding,
              embedding_model, embedding_dims
       FROM takeover_playbook WHERE NOT (id = ANY($1))`,
      [playbookIds],
    )
    const foreignHolds = await query<HoldRow>(
      'SELECT * FROM release_hold WHERE NOT (package_id = ANY($1))',
      [mine],
    )
    const foreignHoldIds = foreignHolds.rows.map((r) => r.id)
    const foreignAdvisories = foreignHoldIds.length
      ? (await query<AdvisoryRow>('SELECT * FROM distro_advisory_outbox WHERE release_hold_id = ANY($1)', [foreignHoldIds])).rows
      : []
    const foreignAudit = foreignHoldIds.length
      ? (await query<AuditRow>('SELECT * FROM audit_log WHERE release_hold_id = ANY($1)', [foreignHoldIds])).rows
      : []

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
      // Restore in FK order: arcs, then the holds that cite them, then their advisories and audit
      // rows. Ids are preserved so anything that cited a restored row — `npm run explain -- --hold
      // <uuid>` in DEMO.md, for one — still resolves.
      //
      // Every insert is ON CONFLICT DO NOTHING because the clear is deliberately PARTIAL: only
      // holds that cite the corpus are forced out by the foreign key, so a pre-existing hold that
      // cites nothing is still sitting there, untouched, along with its advisory and audit rows.
      // Restoring unconditionally would collide with the rows that never left. Which is the same
      // asymmetry the test asserts one screen up — worth having the cleanup agree with it.
      for (const a of foreignArcs.rows) {
        await query(
          `INSERT INTO takeover_playbook
             (id, package_id, label, source, held_out, arc_summary, embedding, embedding_model, embedding_dims)
           VALUES ($1, $2, $3, $4, $5, $6, $7::VECTOR, $8, $9)
           ON CONFLICT (id) DO NOTHING`,
          [a.id, a.package_id, a.label, a.source, a.held_out, a.arc_summary, a.embedding, a.embedding_model, a.embedding_dims],
        )
      }
      for (const h of foreignHolds.rows) {
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
      for (const d of foreignAdvisories) {
        await query(
          `INSERT INTO distro_advisory_outbox (id, release_hold_id, advisory_text, sent, created_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO NOTHING`,
          [d.id, d.release_hold_id, d.advisory_text, d.sent, d.created_at],
        )
      }
      for (const l of foreignAudit) {
        await query(
          `INSERT INTO audit_log (id, release_hold_id, actor, action, detail, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO NOTHING`,
          [l.id, l.release_hold_id, l.actor, l.action, l.detail, l.created_at],
        )
      }
    }

    // The restore is asserted, not assumed: a silent partial restore would leave the next person's
    // demo half-seeded and blame the seed script.
    const restored = await query<{ n: string }>('SELECT count(*) AS n FROM takeover_playbook')
    expect(Number(restored.rows[0]!.n)).toBe(foreignArcs.rows.length)
    const holdsBack = await query<{ n: string }>(
      'SELECT count(*) AS n FROM release_hold WHERE NOT (package_id = ANY($1))',
      [mine],
    )
    expect(Number(holdsBack.rows[0]!.n)).toBe(foreignHolds.rows.length)
  })
})
