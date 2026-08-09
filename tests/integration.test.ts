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
  actorHistory,
  arcWindow,
  commitHold,
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

const LIVE = Boolean(process.env.DATABASE_URL)

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

  it('reads an actor’s history back out of the cluster in order', async () => {
    const history = await actorHistory(PKG, ACTOR, ASOF)
    expect(history).toHaveLength(4)
    expect(history.map((e) => e.kind)).toEqual(['commit', 'commit', 'maintainer_change', 'release'])
  })

  it('never lets a decision see events from after its assessment point', async () => {
    const history = await actorHistory(PKG, ACTOR, new Date('2022-07-01T00:00:00Z'))
    expect(history).toHaveLength(2)
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
})
