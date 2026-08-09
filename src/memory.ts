/**
 * The CockroachDB memory layer.
 *
 * Everything the agent knows lives here and is read back out of the cluster — the agent never
 * consults the seed JSON at decision time. That is the point of the project: the corpus file is
 * only an ingestion source, and by the time a decision is made the sole memory is what is in
 * CockroachDB.
 *
 * Vectors cross the wire as pgvector text literals and are cast with `::VECTOR` at each call
 * site (see src/db.ts).
 */
import type { PoolClient } from 'pg'
import { fromVector, query, toVector, withTransaction } from './db.js'
import type { Label, PlaybookMatch } from './decide.js'

const DAY_MS = 86_400_000

export type StoredEvent = {
  id: string
  packageId: string
  actorId: string
  kind: string
  content: string
  occurredAt: Date
  sourceUrl: string | null
}

export type IngestInput = {
  packageId: string
  actorId: string
  kind: string
  content: string
  occurredAt: string
  sourceUrl?: string | null
}

/** Writes one raw signal into long-term memory. Returns the row id so the UI can cite it. */
export async function ingestEvent(input: IngestInput, embedding: number[]): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO events (package_id, actor_id, kind, content, occurred_at, source_url, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7::VECTOR)
     RETURNING id`,
    [
      input.packageId,
      input.actorId,
      input.kind,
      input.content,
      input.occurredAt,
      input.sourceUrl ?? null,
      toVector(embedding),
    ],
  )
  return result.rows[0]!.id
}

/**
 * Reads an actor's history back out of the cluster as of a point in time.
 *
 * `asOf` is honoured strictly so a replay can never leak future events into a past decision —
 * the 5.6.0 hold has to be made on what was knowable on 2024-02-24, not on the whole file.
 */
export async function actorHistory(
  packageId: string,
  actorId: string,
  asOf: Date,
): Promise<StoredEvent[]> {
  const result = await query<{
    id: string
    package_id: string
    actor_id: string
    kind: string
    content: string
    occurred_at: Date
    source_url: string | null
  }>(
    `SELECT id, package_id, actor_id, kind, content, occurred_at, source_url
     FROM events
     WHERE package_id = $1 AND actor_id = $2 AND occurred_at <= $3
     ORDER BY occurred_at ASC`,
    [packageId, actorId, asOf.toISOString()],
  )
  return result.rows.map((r) => ({
    id: r.id,
    packageId: r.package_id,
    actorId: r.actor_id,
    kind: r.kind,
    content: r.content,
    occurredAt: r.occurred_at,
    sourceUrl: r.source_url,
  }))
}

/** Every actor seen on a package up to `asOf` — used to spot no-history pressure accounts. */
export async function packageHistory(packageId: string, asOf: Date): Promise<StoredEvent[]> {
  const result = await query<{
    id: string
    package_id: string
    actor_id: string
    kind: string
    content: string
    occurred_at: Date
    source_url: string | null
  }>(
    `SELECT id, package_id, actor_id, kind, content, occurred_at, source_url
     FROM events
     WHERE package_id = $1 AND occurred_at <= $2
     ORDER BY occurred_at ASC`,
    [packageId, asOf.toISOString()],
  )
  return result.rows.map((r) => ({
    id: r.id,
    packageId: r.package_id,
    actorId: r.actor_id,
    kind: r.kind,
    content: r.content,
    occurredAt: r.occurred_at,
    sourceUrl: r.source_url,
  }))
}

export type ArcWindow = {
  windowStart: Date
  windowEnd: Date
  eventCount: number
}

export function arcWindow(asOf: Date, windowDays: number, eventCount: number): ArcWindow {
  return {
    windowStart: new Date(asOf.getTime() - windowDays * DAY_MS),
    windowEnd: asOf,
    eventCount,
  }
}

/** One rolling arc row per (package, actor) — the unit of memory decisions are made on. */
export async function upsertActorArc(
  packageId: string,
  actorId: string,
  window: ArcWindow,
  summary: string,
  embedding: number[],
): Promise<string> {
  await query('DELETE FROM actor_arcs WHERE package_id = $1 AND actor_id = $2', [
    packageId,
    actorId,
  ])
  const result = await query<{ id: string }>(
    `INSERT INTO actor_arcs
       (package_id, actor_id, window_start, window_end, event_count, arc_summary, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7::VECTOR)
     RETURNING id`,
    [
      packageId,
      actorId,
      window.windowStart.toISOString(),
      window.windowEnd.toISOString(),
      window.eventCount,
      summary,
      toVector(embedding),
    ],
  )
  return result.rows[0]!.id
}

export const SCOPED_NEIGHBOUR_SQL = `SELECT id, actor_id, kind, content, occurred_at, source_url,
       embedding <=> $2::VECTOR AS distance
FROM events
WHERE package_id = $1
ORDER BY embedding <=> $2::VECTOR
LIMIT $3`

export type ScopedNeighbour = StoredEvent & { similarity: number }

/**
 * Prefix-scoped ANN search: the vector index's leading column is `package_id`, so the scan is
 * pre-filtered to one package's own history instead of walking every package in the cluster.
 */
export async function scopedNeighbours(
  packageId: string,
  embedding: number[],
  limit = 20,
): Promise<ScopedNeighbour[]> {
  const result = await query<{
    id: string
    actor_id: string
    kind: string
    content: string
    occurred_at: Date
    source_url: string | null
    distance: string
  }>(SCOPED_NEIGHBOUR_SQL, [packageId, toVector(embedding), limit])
  return result.rows.map((r) => ({
    id: r.id,
    packageId,
    actorId: r.actor_id,
    kind: r.kind,
    content: r.content,
    occurredAt: r.occurred_at,
    sourceUrl: r.source_url,
    similarity: 1 - Number(r.distance),
  }))
}

/** True when a CockroachDB plan shows the vector index was entered with a bounded prefix. */
export function hasPrefixSpans(plan: string): boolean {
  return /prefix spans:/i.test(plan)
}

export type ExplainResult = { plan: string; prefixScoped: boolean; usedVectorIndex: boolean }

/**
 * Runs EXPLAIN on the prefix-scoped query. The `prefix spans` line in the output is the
 * on-camera proof that retrieval was scoped to this package — it is asserted in the test suite
 * and shown in the demo UI rather than being claimed in prose.
 */
export async function explainScoped(
  packageId: string,
  embedding: number[],
  limit = 20,
): Promise<ExplainResult> {
  const result = await query<{ info: string }>(`EXPLAIN ${SCOPED_NEIGHBOUR_SQL}`, [
    packageId,
    toVector(embedding),
    limit,
  ])
  const plan = result.rows.map((r) => r.info).join('\n')
  return {
    plan,
    prefixScoped: hasPrefixSpans(plan),
    usedVectorIndex: /vector search/i.test(plan),
  }
}

/**
 * Unscoped search against the playbook: a takeover shape learned anywhere must be matchable
 * from any package, so this one deliberately does NOT filter by package_id.
 *
 * Held-out arcs are excluded here rather than at insert time so the same table can hold both
 * splits and the exclusion is visible in the query the agent actually runs.
 */
export async function matchPlaybook(
  embedding: number[],
  limit = 5,
  /** Leave-one-out support: calibration must not let an arc match itself. */
  excludeId?: string,
): Promise<PlaybookMatch[]> {
  const result = await query<{
    id: string
    package_id: string
    label: string
    source: string
    distance: string
  }>(
    `SELECT id, package_id, label, source, embedding <=> $1::VECTOR AS distance
     FROM takeover_playbook
     WHERE held_out = false AND ($3::UUID IS NULL OR id <> $3::UUID)
     ORDER BY embedding <=> $1::VECTOR
     LIMIT $2`,
    [toVector(embedding), limit, excludeId ?? null],
  )
  return result.rows.map((r) => ({
    id: r.id,
    packageId: r.package_id,
    label: r.label as Label,
    source: r.source,
    similarity: 1 - Number(r.distance),
  }))
}

export type StoredArc = {
  id: string
  packageId: string
  label: Label
  source: string
  arcSummary: string
  embedding: number[]
}

/** Reads arcs straight out of the cluster so calibration and the bench never re-embed. */
export async function playbookArcs(heldOut: boolean): Promise<StoredArc[]> {
  const result = await query<{
    id: string
    package_id: string
    label: string
    source: string
    arc_summary: string
    embedding: string
  }>(
    `SELECT id, package_id, label, source, arc_summary, embedding::STRING AS embedding
     FROM takeover_playbook WHERE held_out = $1 ORDER BY package_id`,
    [heldOut],
  )
  return result.rows.map((r) => ({
    id: r.id,
    packageId: r.package_id,
    label: r.label as Label,
    source: r.source,
    arcSummary: r.arc_summary,
    embedding: fromVector(r.embedding),
  }))
}

/** The stored rolling arc for an actor, used by `npm run explain` after a replay. */
export async function loadActorArc(
  packageId: string,
  actorId: string,
): Promise<{ id: string; arcSummary: string; embedding: number[] } | null> {
  const result = await query<{ id: string; arc_summary: string; embedding: string }>(
    `SELECT id, arc_summary, embedding::STRING AS embedding
     FROM actor_arcs WHERE package_id = $1 AND actor_id = $2 LIMIT 1`,
    [packageId, actorId],
  )
  const row = result.rows[0]
  if (!row) return null
  return { id: row.id, arcSummary: row.arc_summary, embedding: fromVector(row.embedding) }
}

export type PlaybookSeed = {
  packageId: string
  label: Label
  source: string
  heldOut: boolean
  arcSummary: string
}

export async function insertPlaybookArc(seed: PlaybookSeed, embedding: number[]): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO takeover_playbook (package_id, label, source, held_out, arc_summary, embedding)
     VALUES ($1, $2, $3, $4, $5, $6::VECTOR)
     RETURNING id`,
    [seed.packageId, seed.label, seed.source, seed.heldOut, seed.arcSummary, toVector(embedding)],
  )
  return result.rows[0]!.id
}

export async function clearPlaybook(): Promise<void> {
  // release_hold references takeover_playbook, so holds must go first or the FK blocks the delete.
  await query('DELETE FROM audit_log')
  await query('DELETE FROM distro_advisory_outbox')
  await query('DELETE FROM release_hold')
  await query('DELETE FROM takeover_playbook')
}

export type HoldInput = {
  packageId: string
  releaseVersion: string
  reason: string
  matchedPlaybookId: string | null
  similarity: number
  advisoryText: string
  auditDetail: string
}

export type HoldResult = {
  holdId: string
  advisoryId: string
  auditId: string
  committedAt: Date
  writes: string[]
}

/**
 * The atomic HOLD — four writes, one transaction, one COMMIT.
 *
 * This is the "why CockroachDB and not a vector database bolted onto a relational one" proof:
 * the vector search that produced the decision and the transactional state change that acts on
 * it are the same system, so a hold can never half-land. A release cannot end up blocked with no
 * advisory queued, and an advisory can never go out for a hold that was rolled back.
 */
export async function commitHold(input: HoldInput): Promise<HoldResult> {
  return withTransaction(async (client: PoolClient) => {
    const hold = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO release_hold
         (package_id, release_version, reason, matched_playbook_id, similarity)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [
        input.packageId,
        input.releaseVersion,
        input.reason,
        input.matchedPlaybookId,
        input.similarity,
      ],
    )
    const holdId = hold.rows[0]!.id

    await client.query(
      `INSERT INTO trust_state (package_id, status, updated_at)
       VALUES ($1, 'held', now())
       ON CONFLICT (package_id) DO UPDATE SET status = 'held', updated_at = now()`,
      [input.packageId],
    )

    const advisory = await client.query<{ id: string }>(
      `INSERT INTO distro_advisory_outbox (release_hold_id, advisory_text)
       VALUES ($1, $2) RETURNING id`,
      [holdId, input.advisoryText],
    )

    const audit = await client.query<{ id: string }>(
      `INSERT INTO audit_log (release_hold_id, actor, action, detail)
       VALUES ($1, 'agent', 'hold', $2) RETURNING id`,
      [holdId, input.auditDetail],
    )

    return {
      holdId,
      advisoryId: advisory.rows[0]!.id,
      auditId: audit.rows[0]!.id,
      committedAt: hold.rows[0]!.created_at,
      writes: [
        'INSERT release_hold',
        "UPDATE trust_state -> 'held'",
        'INSERT distro_advisory_outbox',
        'INSERT audit_log',
      ],
    }
  })
}

export type HoldEvidence = {
  hold: {
    id: string
    packageId: string
    releaseVersion: string
    reason: string
    similarity: number
    createdAt: Date
  }
  matchedArc: { packageId: string; label: string; source: string; arcSummary: string } | null
  trustStatus: string | null
  advisories: { id: string; advisoryText: string; sent: boolean }[]
  auditTrail: { actor: string; action: string; detail: string | null; createdAt: Date }[]
}

/**
 * The "explain your hold" read path — the same rows the Managed MCP Server surfaces when a
 * downstream distro packager asks why their release stopped.
 */
export async function holdEvidence(holdId: string): Promise<HoldEvidence | null> {
  const hold = await query<{
    id: string
    package_id: string
    release_version: string
    reason: string
    similarity: string
    created_at: Date
    matched_playbook_id: string | null
  }>(
    `SELECT id, package_id, release_version, reason, similarity, created_at, matched_playbook_id
     FROM release_hold WHERE id = $1`,
    [holdId],
  )
  if (!hold.rows.length) return null
  const row = hold.rows[0]!

  const matched = row.matched_playbook_id
    ? await query<{ package_id: string; label: string; source: string; arc_summary: string }>(
        `SELECT package_id, label, source, arc_summary FROM takeover_playbook WHERE id = $1`,
        [row.matched_playbook_id],
      )
    : null

  const trust = await query<{ status: string }>(
    'SELECT status FROM trust_state WHERE package_id = $1',
    [row.package_id],
  )

  const advisories = await query<{ id: string; advisory_text: string; sent: boolean }>(
    'SELECT id, advisory_text, sent FROM distro_advisory_outbox WHERE release_hold_id = $1',
    [holdId],
  )

  const audit = await query<{ actor: string; action: string; detail: string | null; created_at: Date }>(
    `SELECT actor, action, detail, created_at FROM audit_log
     WHERE release_hold_id = $1 ORDER BY created_at ASC`,
    [holdId],
  )

  return {
    hold: {
      id: row.id,
      packageId: row.package_id,
      releaseVersion: row.release_version,
      reason: row.reason,
      similarity: Number(row.similarity),
      createdAt: row.created_at,
    },
    matchedArc: matched?.rows[0]
      ? {
          packageId: matched.rows[0].package_id,
          label: matched.rows[0].label,
          source: matched.rows[0].source,
          arcSummary: matched.rows[0].arc_summary,
        }
      : null,
    trustStatus: trust.rows[0]?.status ?? null,
    advisories: advisories.rows.map((r) => ({
      id: r.id,
      advisoryText: r.advisory_text,
      sent: r.sent,
    })),
    auditTrail: audit.rows.map((r) => ({
      actor: r.actor,
      action: r.action,
      detail: r.detail,
      createdAt: r.created_at,
    })),
  }
}

/** Wipes only what a replay owns, so the demo is idempotent and re-runnable in front of a judge. */
export async function resetPackage(packageId: string): Promise<void> {
  await query(
    `DELETE FROM audit_log WHERE release_hold_id IN
       (SELECT id FROM release_hold WHERE package_id = $1)`,
    [packageId],
  )
  await query(
    `DELETE FROM distro_advisory_outbox WHERE release_hold_id IN
       (SELECT id FROM release_hold WHERE package_id = $1)`,
    [packageId],
  )
  await query('DELETE FROM release_hold WHERE package_id = $1', [packageId])
  await query('DELETE FROM actor_arcs WHERE package_id = $1', [packageId])
  await query('DELETE FROM events WHERE package_id = $1', [packageId])
  await query(
    `INSERT INTO trust_state (package_id, status, updated_at) VALUES ($1, 'trusted', now())
     ON CONFLICT (package_id) DO UPDATE SET status = 'trusted', updated_at = now()`,
    [packageId],
  )
}
