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
import { directSqlReader, fromVector, query, toVector, withTransaction } from './db.js'
import { assertUuid, resolveSqlReader, sqlLiteral, vectorLiteral, type SqlReader } from './mcp.js'
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
 * The same prefix-scoped query as `SCOPED_NEIGHBOUR_SQL`, as one self-contained statement.
 *
 * MCP tool calls carry finished SQL text — there is no bind-parameter channel — so the plan the
 * Managed MCP Server is asked for has to be literal. Two differences from the parameterised form,
 * both forced and both harmless to the plan:
 *
 *  - the `embedding <=> $2` **projection** is dropped, because printing a 1024-dimension vector
 *    twice in one statement blows past the server's 16,384-char limit on its own. What proves
 *    prefix scoping is the `ORDER BY … <=> …` + `WHERE package_id = …` pair, which is intact.
 *  - the vector is rounded (see `vectorLiteral`), because full float precision is ~20 KB of text.
 *    EXPLAIN plans the query; it does not evaluate the distances.
 */
export function scopedNeighbourExplainSql(
  packageId: string,
  embedding: number[],
  limit = 20,
  decimals = 6,
): string {
  return `SELECT id, actor_id, kind, content, occurred_at, source_url
FROM events
WHERE package_id = ${sqlLiteral(packageId)}
ORDER BY embedding <=> ${sqlLiteral(vectorLiteral(embedding, decimals))}::VECTOR
LIMIT ${Math.trunc(limit)}`
}

/**
 * `EXPLAIN` the prefix-scoped retrieval through whichever audit path is in force.
 *
 * Over MCP this is the server's own `explain_query` tool: the `prefix spans` line then arrives
 * from the cluster through a read-only, audit-logged channel that the agent does not control,
 * which is what makes it evidence to a third party rather than a claim by us.
 */
export async function explainScopedVia(
  reader: SqlReader,
  packageId: string,
  embedding: number[],
  limit = 20,
): Promise<ExplainResult> {
  const plan = await reader.explain(scopedNeighbourExplainSql(packageId, embedding, limit))
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
 * The audit path, resolved once per entry point: Managed MCP Server if it is configured and
 * reachable, direct SQL otherwise — never silently, always with a printable reason.
 */
export async function auditReader(env: NodeJS.ProcessEnv = process.env): Promise<SqlReader> {
  return resolveSqlReader(directSqlReader, env)
}

/**
 * The five statements behind "explain your hold", as finished SQL.
 *
 * They are literal rather than parameterised because the Managed MCP Server's `select_query`
 * tool takes SQL text and has no bind channel — so ids are validated (`assertUuid`) or quoted
 * (`sqlLiteral`) here rather than concatenated at a call site. Two more properties are deliberate:
 *
 *  - **every SELECT carries an explicit LIMIT.** An unbounded `select_query` is capped at 25 rows
 *    by the server; a silently truncated audit trail that still looks complete is exactly the
 *    failure a distro packager cannot afford.
 *  - **timestamps are cast to STRING.** The MCP path returns JSON and the pg path returns `Date`;
 *    casting in SQL makes both paths agree on the wire so one parser serves both.
 *
 * Exported so the test suite can assert their shape and their size without a cluster.
 */
export const EVIDENCE_SQL = {
  hold: (holdId: string): string =>
    `SELECT id, package_id, release_version, reason, similarity,
        created_at::STRING AS created_at, matched_playbook_id
 FROM release_hold WHERE id = ${sqlLiteral(assertUuid(holdId))} LIMIT 1`,

  matchedArc: (playbookId: string): string =>
    `SELECT package_id, label, source, arc_summary
 FROM takeover_playbook WHERE id = ${sqlLiteral(assertUuid(playbookId))} LIMIT 1`,

  trust: (packageId: string): string =>
    `SELECT status FROM trust_state WHERE package_id = ${sqlLiteral(packageId)} LIMIT 1`,

  advisories: (holdId: string): string =>
    `SELECT id, advisory_text, sent FROM distro_advisory_outbox
 WHERE release_hold_id = ${sqlLiteral(assertUuid(holdId))} ORDER BY created_at ASC LIMIT 1000`,

  auditTrail: (holdId: string): string =>
    `SELECT actor, action, detail, created_at::STRING AS created_at FROM audit_log
 WHERE release_hold_id = ${sqlLiteral(assertUuid(holdId))} ORDER BY created_at ASC LIMIT 1000`,
} as const

const str = (v: unknown): string => (v == null ? '' : String(v))
const nullableStr = (v: unknown): string | null => (v == null ? null : String(v))
const bool = (v: unknown): boolean => v === true || v === 'true' || v === 't' || v === 1
const date = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)))

/**
 * The "explain your hold" read path — five read-only statements, run through the Managed MCP
 * Server when it is configured and through the pg pool when it is not.
 *
 * This is the path a downstream distro packager takes when their release stops: they are not the
 * agent, they should not hold the agent's write credentials, and MCP is read-only at the protocol
 * layer even where the SQL identity underneath could write. Routing the audit through it — while
 * the HOLD itself stays on a direct-SQL transaction, because one statement per call cannot express
 * a four-write COMMIT — is the split the two systems are actually shaped for.
 *
 * Pass a reader from `auditReader()` to choose the path; the default is direct SQL, so every
 * existing caller behaves exactly as before.
 */
export async function holdEvidence(
  holdId: string,
  reader: SqlReader = directSqlReader('default reader — caller did not resolve an audit path'),
): Promise<HoldEvidence | null> {
  const holdRows = await reader.select<Record<string, unknown>>(EVIDENCE_SQL.hold(holdId))
  const row = holdRows[0]
  if (!row) return null

  const matchedPlaybookId = nullableStr(row.matched_playbook_id)
  const matched = matchedPlaybookId
    ? (await reader.select<Record<string, unknown>>(EVIDENCE_SQL.matchedArc(matchedPlaybookId)))[0]
    : undefined

  const trust = (await reader.select<Record<string, unknown>>(EVIDENCE_SQL.trust(str(row.package_id))))[0]
  const advisories = await reader.select<Record<string, unknown>>(EVIDENCE_SQL.advisories(holdId))
  const audit = await reader.select<Record<string, unknown>>(EVIDENCE_SQL.auditTrail(holdId))

  return {
    hold: {
      id: str(row.id),
      packageId: str(row.package_id),
      releaseVersion: str(row.release_version),
      reason: str(row.reason),
      similarity: Number(row.similarity),
      createdAt: date(row.created_at),
    },
    matchedArc: matched
      ? {
          packageId: str(matched.package_id),
          label: str(matched.label),
          source: str(matched.source),
          arcSummary: str(matched.arc_summary),
        }
      : null,
    trustStatus: trust ? str(trust.status) : null,
    advisories: advisories.map((a) => ({
      id: str(a.id),
      advisoryText: str(a.advisory_text),
      sent: bool(a.sent),
    })),
    auditTrail: audit.map((a) => ({
      actor: str(a.actor),
      action: str(a.action),
      detail: nullableStr(a.detail),
      createdAt: date(a.created_at),
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
