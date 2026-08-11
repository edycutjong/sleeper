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
import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { config } from './config.js'
import { directSqlReader, fromVector, query, toVector, withTransaction } from './db.js'
import { OFFLINE } from './embeddings.js'
import { assertUuid, resolveSqlReader, sqlLiteral, vectorLiteral, type SqlReader } from './mcp.js'
import type { Label, PlaybookMatch } from './decide.js'

const DAY_MS = 86_400_000

/**
 * The model id written next to every vector produced by the offline stand-in.
 *
 * It is deliberately NOT a Bedrock-shaped name. `SLEEPER_OFFLINE=1` produces hashed
 * bag-of-words vectors that are the right width and nothing else; if they were stored with no
 * provenance they would be indistinguishable from Titan output in the same table, and the
 * benchmark would happily compute a recall figure over a mixture of the two. Self-identifying
 * vectors are what make that impossible rather than merely discouraged.
 */
export const OFFLINE_EMBEDDING_MODEL = 'offline-fnv1a-1024'

export type EmbeddingProvenance = { model: string; dims: number }

/**
 * Which model produced the vectors this process is generating right now.
 *
 * `toVector` (src/db.ts) validates WIDTH, and width is not identity: every 1024-dimension model
 * ever shipped passes that check. Swapping BEDROCK_EMBEDDING_MODEL_ID and re-running would write
 * vectors from a different geometry into the same cosine index as the old ones, and cosine
 * distance between two unrelated embedding spaces is a number — just not a meaningful one. Storing
 * the model id per row is what turns "silently poisoned corpus" into "query returns nothing and
 * says why".
 */
export function embeddingProvenance(): EmbeddingProvenance {
  return {
    model: OFFLINE ? OFFLINE_EMBEDDING_MODEL : config.aws.embeddingModelId,
    dims: config.aws.embeddingDimensions,
  }
}

/**
 * Upper bound on rows returned by the two history reads, overridable with SLEEPER_HISTORY_LIMIT.
 *
 * 5,000 events is far beyond the xz timeline and still small enough to embed the resulting arc
 * prompt. The number exists so that pointing this at a package with a decade of firehose history
 * degrades into a bounded, warned-about read rather than into an out-of-memory Lambda.
 */
export const HISTORY_LIMIT = Math.max(1, Number(process.env.SLEEPER_HISTORY_LIMIT ?? 5000))

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

/**
 * The identity of a signal, independent of how many times it was delivered.
 *
 * Derived from the five fields that make an event that event — package, actor, kind, when, what.
 * `source_url` is excluded on purpose: the same commit arriving once from a webhook and once from
 * a backfill can carry different citation URLs, and it is still one commit.
 *
 * `occurredAt` is normalised through Date so that '2024-02-24T00:00:00Z' and
 * '2024-02-24T00:00:00.000+00:00' — the same instant, two encodings, two delivery paths — collapse
 * to one key instead of quietly becoming two events. An unparseable timestamp is hashed verbatim
 * rather than thrown on: rejecting it belongs to validation, not to key derivation.
 *
 * Exported so the derivation is unit-testable without a cluster, and so an operator can compute a
 * key by hand when reconciling a suspected duplicate.
 */
export function eventKey(input: IngestInput): string {
  const parsed = Date.parse(input.occurredAt)
  const occurredAt = Number.isNaN(parsed) ? input.occurredAt : new Date(parsed).toISOString()
  // JSON-encoded rather than concatenated with a separator: any separator character can also
  // occur inside `content`, and a field boundary a value can forge is how two different events end
  // up hashing to one key ("ab" + "c" and "a" + "bc" are the same string).
  const material = JSON.stringify([
    input.packageId,
    input.actorId,
    input.kind,
    occurredAt,
    input.content,
  ])
  return createHash('sha256').update(material, 'utf8').digest('hex')
}

/**
 * Writes one raw signal into long-term memory. Returns the row id so the UI can cite it.
 *
 * Idempotent by construction. Both live entry points are at-least-once: API Gateway/Lambda retries
 * a delivery whose response it did not see, and a judge re-running `npm run replay` re-feeds the
 * whole timeline. A duplicate here is not a cosmetic double row — every ratio in src/signals.ts
 * (build-system share, release count, privilege changes) is computed over these rows, so a
 * redelivered maintainer_change moves the arc that the hold decision is made on.
 *
 * The uniqueness is enforced by the database rather than by a read-then-write check, because two
 * concurrent deliveries would both pass the check and both insert. On conflict the existing id is
 * returned, so a retried delivery gets the same answer as the first one.
 */
export async function ingestEvent(input: IngestInput, embedding: number[]): Promise<string> {
  const key = eventKey(input)
  const { model, dims } = embeddingProvenance()
  const result = await query<{ id: string }>(
    `INSERT INTO events
       (package_id, actor_id, kind, content, occurred_at, source_url, event_key,
        embedding, embedding_model, embedding_dims)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::VECTOR, $9, $10)
     ON CONFLICT (event_key) DO NOTHING
     RETURNING id`,
    [
      input.packageId,
      input.actorId,
      input.kind,
      input.content,
      input.occurredAt,
      input.sourceUrl ?? null,
      key,
      toVector(embedding),
      model,
      dims,
    ],
  )
  if (result.rows[0]) return result.rows[0].id

  // DO NOTHING returns zero rows on conflict, which is the duplicate-delivery case: the event is
  // already in memory, and the caller still needs its id to cite it.
  const existing = await query<{ id: string }>('SELECT id FROM events WHERE event_key = $1', [key])
  const row = existing.rows[0]
  if (!row) {
    // Only reachable if the conflicting row was deleted between the two statements (a concurrent
    // `resetPackage`). Say so plainly rather than returning a fabricated id.
    throw new Error(
      `Event ${key.slice(0, 12)}… conflicted on insert but is no longer present — ` +
        'the package was reset concurrently. Re-run the ingest.',
    )
  }
  return row.id
}

type EventRow = {
  id: string
  package_id: string
  actor_id: string
  kind: string
  content: string
  occurred_at: Date
  source_url: string | null
}

const toStoredEvent = (r: EventRow): StoredEvent => ({
  id: r.id,
  packageId: r.package_id,
  actorId: r.actor_id,
  kind: r.kind,
  content: r.content,
  occurredAt: r.occurred_at,
  sourceUrl: r.source_url,
})

/**
 * Both history reads take the NEWEST `limit` rows and then re-sort them ascending.
 *
 * The obvious `ORDER BY occurred_at ASC LIMIT n` truncates from the wrong end: it would drop the
 * most recent events, which are precisely the ones inside the rolling window the arc is built
 * from, while keeping years of ancient history that only contributes tenure. Reversing the sort
 * and re-ordering in an outer query costs one extra sort of at most `limit` rows and keeps the
 * decision-relevant tail intact.
 */
function boundedHistorySql(where: string, limitParam: string): string {
  return `SELECT id, package_id, actor_id, kind, content, occurred_at, source_url FROM (
  SELECT id, package_id, actor_id, kind, content, occurred_at, source_url
  FROM events
  WHERE ${where}
  ORDER BY occurred_at DESC
  LIMIT ${limitParam}
) ORDER BY occurred_at ASC`
}

export const ACTOR_HISTORY_SQL = boundedHistorySql(
  'package_id = $1 AND actor_id = $2 AND occurred_at <= $3',
  '$4',
)

export const PACKAGE_HISTORY_SQL = boundedHistorySql(
  'package_id = $1 AND occurred_at <= $2',
  '$3',
)

/**
 * Truncation must never be silent. A held or released decision made on a partial history is still
 * a decision, and the operator has to be able to see in the log that it was made on less than the
 * whole record.
 */
function warnIfTruncated(what: string, rows: number, limit: number): void {
  if (rows < limit) return
  console.warn(
    `[memory] ${what} hit the ${limit}-row read limit — the arc was built on the most recent ` +
      `${limit} events only, not the full record. Raise SLEEPER_HISTORY_LIMIT to widen it.`,
  )
}

/**
 * Reads an actor's history back out of the cluster as of a point in time.
 *
 * `asOf` is honoured strictly so a replay can never leak future events into a past decision —
 * the 5.6.0 hold has to be made on what was knowable on 2024-02-24, not on the whole file.
 *
 * Bounded by `HISTORY_LIMIT`: an unbounded read here is a live handle on "how many events has this
 * package ever had", and the caller turns every returned row into a line of an LLM prompt.
 */
export async function actorHistory(
  packageId: string,
  actorId: string,
  asOf: Date,
  limit = HISTORY_LIMIT,
): Promise<StoredEvent[]> {
  const result = await query<EventRow>(ACTOR_HISTORY_SQL, [
    packageId,
    actorId,
    asOf.toISOString(),
    limit,
  ])
  warnIfTruncated(`actorHistory(${packageId}, ${actorId})`, result.rows.length, limit)
  return result.rows.map(toStoredEvent)
}

/** Every actor seen on a package up to `asOf` — used to spot no-history pressure accounts. */
export async function packageHistory(
  packageId: string,
  asOf: Date,
  limit = HISTORY_LIMIT,
): Promise<StoredEvent[]> {
  const result = await query<EventRow>(PACKAGE_HISTORY_SQL, [
    packageId,
    asOf.toISOString(),
    limit,
  ])
  warnIfTruncated(`packageHistory(${packageId})`, result.rows.length, limit)
  return result.rows.map(toStoredEvent)
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

/**
 * One rolling arc row per (package, actor) — the unit of memory decisions are made on.
 *
 * A single statement against `actor_arcs_pkg_actor_key`, not a DELETE followed by an INSERT. The
 * pair had two failure modes and no transaction around them: two assessments of the same actor
 * running concurrently (a webhook and a replay, which is the normal case here) could both DELETE
 * and then both INSERT, leaving TWO arc rows for one actor — after which `loadActorArc`'s
 * `LIMIT 1` returns whichever the cluster feels like and the demo shows a stale summary; and a
 * crash in the gap between the two statements left the actor with NO arc at all, which reads
 * downstream as "we have never seen this account".
 *
 * ON CONFLICT makes the invariant the schema's job. The row id is stable across updates, which
 * also means anything that cited an arc keeps citing the same one.
 */
export async function upsertActorArc(
  packageId: string,
  actorId: string,
  window: ArcWindow,
  summary: string,
  embedding: number[],
): Promise<string> {
  const { model, dims } = embeddingProvenance()
  const result = await query<{ id: string }>(
    `INSERT INTO actor_arcs
       (package_id, actor_id, window_start, window_end, event_count, arc_summary,
        embedding, embedding_model, embedding_dims)
     VALUES ($1, $2, $3, $4, $5, $6, $7::VECTOR, $8, $9)
     ON CONFLICT (package_id, actor_id) DO UPDATE SET
       window_start = excluded.window_start,
       window_end = excluded.window_end,
       event_count = excluded.event_count,
       arc_summary = excluded.arc_summary,
       embedding = excluded.embedding,
       embedding_model = excluded.embedding_model,
       embedding_dims = excluded.embedding_dims
     RETURNING id`,
    [
      packageId,
      actorId,
      window.windowStart.toISOString(),
      window.windowEnd.toISOString(),
      window.eventCount,
      summary,
      toVector(embedding),
      model,
      dims,
    ],
  )
  return result.rows[0]!.id
}

/**
 * The `@events_pkg_embedding_idx` hint is deliberate, and worth being straight about.
 *
 * `events` also carries ordinary time-ordered indexes on `(package_id, …)` for the history reads.
 * At demo row counts a cost-based optimizer will quite correctly prefer scanning one of those and
 * sorting a handful of rows over descending an ANN index — sorting four events is cheaper than any
 * index lookup, and CockroachDB is right about that. It is not right about which query this is:
 * ANN retrieval over the package's own memory is the architecture, the plan is shown on camera and
 * asserted in the test suite, and a plan that silently becomes a sort-of-everything at four rows
 * is not evidence about how the system behaves at four million.
 *
 * The hint pins WHICH index is used. It does not manufacture the `prefix spans` line — that comes
 * from the index's own leading column being `=`-constrained, and would be absent if the query
 * failed to constrain `package_id`.
 */
export const SCOPED_NEIGHBOUR_SQL = `SELECT id, actor_id, kind, content, occurred_at, source_url,
       embedding <=> $2::VECTOR AS distance
FROM events@events_pkg_embedding_idx
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
FROM events@events_pkg_embedding_idx
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
 * The query the hold decision is actually made on.
 *
 * Unscoped by PACKAGE on purpose: a takeover shape learned anywhere must be matchable from any
 * package, so there is no `package_id` filter. But it is scoped on the two dimensions that decide
 * whether a candidate is even eligible, and both of them are index prefix columns rather than
 * WHERE-clause afterthoughts (see the comment on the index in sql/schema.sql):
 *
 *  - `held_out = false` — an ANN index returns k candidates and only then applies a non-prefix
 *    filter, so held-out arcs would eat top-k slots and be discarded afterwards. `decide()` needs
 *    a takeover AND a benign neighbour to compute its margin; a one-sided neighbourhood makes the
 *    margin zero and the gate silently does not fire.
 *  - `embedding_model` — cosine distance between vectors from two different models is a number
 *    with no meaning. Filtering here means a corpus embedded by a different model is not searched
 *    at all rather than searched wrongly.
 *
 * The leave-one-out exclusion stays a plain predicate: it targets one row by primary key, so
 * losing at most one candidate out of k is bounded and harmless, and making it a prefix column
 * would mean re-indexing the corpus per calibration query.
 *
 * Exported so `explainPlaybook` runs EXPLAIN on this exact text — the decision query and the
 * proof-of-scoping query must not be allowed to drift apart.
 */
export const PLAYBOOK_MATCH_SQL = `SELECT id, package_id, label, source,
       embedding <=> $1::VECTOR AS distance
FROM takeover_playbook
WHERE held_out = false
  AND embedding_model = $4
  AND ($3::UUID IS NULL OR id <> $3::UUID)
ORDER BY embedding <=> $1::VECTOR
LIMIT $2`

export async function matchPlaybook(
  embedding: number[],
  limit = 5,
  /** Leave-one-out support: calibration must not let an arc match itself. */
  excludeId?: string,
): Promise<PlaybookMatch[]> {
  const { model } = embeddingProvenance()
  const result = await query<{
    id: string
    package_id: string
    label: string
    source: string
    distance: string
  }>(PLAYBOOK_MATCH_SQL, [toVector(embedding), limit, excludeId ?? null, model])

  if (result.rows.length === 0) await assertPlaybookModel(model)

  return result.rows.map((r) => ({
    id: r.id,
    packageId: r.package_id,
    label: r.label as Label,
    source: r.source,
    similarity: 1 - Number(r.distance),
  }))
}

/**
 * Refuses to decide on a corpus embedded by a different model.
 *
 * An empty match set is ambiguous: it means either "the playbook is empty, run `npm run seed`" or
 * "the playbook is full of vectors from a model that is not the one loaded right now". The second
 * is the dangerous one, because `decide()` reads no matches as "no takeover-labelled arc was
 * retrieved" and releases the package — a confident-looking pass produced by a configuration
 * mistake. Checking only on the empty path keeps the cost off the hot path entirely.
 *
 * Exported so an entry point can call it once at startup and fail before the first release event
 * rather than at the moment a decision is due.
 */
export async function assertPlaybookModel(model = embeddingProvenance().model): Promise<void> {
  const others = await query<{ embedding_model: string; n: string }>(
    `SELECT embedding_model, count(*) AS n FROM takeover_playbook
     WHERE held_out = false AND embedding_model <> $1
     GROUP BY embedding_model ORDER BY n DESC`,
    [model],
  )
  if (others.rows.length === 0) return
  const found = others.rows.map((r) => `${r.embedding_model} (${r.n} arcs)`).join(', ')
  throw new Error(
    `Embedding model mismatch: this process embeds with "${model}", but the playbook corpus in ` +
      `CockroachDB was written by ${found}. Cosine distance between two embedding spaces is ` +
      'meaningless, so Sleeper will not decide on it. Re-seed with `npm run seed` under the ' +
      'current model, or point the process back at the model that wrote the corpus.',
  )
}

/**
 * EXPLAIN of the playbook match — the same proof `explainScoped` provides, applied to the query
 * that actually decides.
 *
 * This exists because of an uncomfortable asymmetry the project shipped with: the prefix-scoping
 * claim was demonstrated on the events retrieval, which feeds a UI panel, while the playbook
 * retrieval — the one whose top-k determines whether a release is held — had never been EXPLAINed
 * at all. A `prefix spans` line on the wrong query is not evidence. Both are asserted in
 * tests/integration.test.ts now.
 */
export async function explainPlaybook(
  embedding: number[],
  limit = 5,
  excludeId?: string,
): Promise<ExplainResult> {
  const { model } = embeddingProvenance()
  const result = await query<{ info: string }>(`EXPLAIN ${PLAYBOOK_MATCH_SQL}`, [
    toVector(embedding),
    limit,
    excludeId ?? null,
    model,
  ])
  const plan = result.rows.map((r) => r.info).join('\n')
  return {
    plan,
    prefixScoped: hasPrefixSpans(plan),
    usedVectorIndex: /vector search/i.test(plan),
  }
}

export type StoredArc = {
  id: string
  packageId: string
  label: Label
  source: string
  arcSummary: string
  embedding: number[]
}

/**
 * Reads arcs straight out of the cluster so calibration and the bench never re-embed.
 *
 * Filtered by embedding model for the same reason `matchPlaybook` is, and with a concrete case in
 * mind: the integration tests write offline hash vectors into `takeover_playbook` on whatever
 * cluster they are pointed at, and `npm run bench` reads that table to compute a published recall
 * figure. Without this filter a test run and a benchmark run sharing a cluster would silently
 * blend the two corpora into one number.
 */
export async function playbookArcs(heldOut: boolean): Promise<StoredArc[]> {
  const { model } = embeddingProvenance()
  const result = await query<{
    id: string
    package_id: string
    label: string
    source: string
    arc_summary: string
    embedding: string
  }>(
    `SELECT id, package_id, label, source, arc_summary, embedding::STRING AS embedding
     FROM takeover_playbook WHERE held_out = $1 AND embedding_model = $2 ORDER BY package_id`,
    [heldOut, model],
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
  const { model, dims } = embeddingProvenance()
  const result = await query<{ id: string }>(
    `INSERT INTO takeover_playbook
       (package_id, label, source, held_out, arc_summary, embedding, embedding_model, embedding_dims)
     VALUES ($1, $2, $3, $4, $5, $6::VECTOR, $7, $8)
     RETURNING id`,
    [
      seed.packageId,
      seed.label,
      seed.source,
      seed.heldOut,
      seed.arcSummary,
      toVector(embedding),
      model,
      dims,
    ],
  )
  return result.rows[0]!.id
}

export type ClearPlaybookOptions = {
  /**
   * Permit deleting holds that cite the corpus. Defaults to SLEEPER_FORCE_CLEAR=1, so the escape
   * hatch is reachable from `npm run seed` without editing the script.
   */
  force?: boolean
}

/**
 * Empties the retrieval corpus so it can be re-seeded — without taking the audit trail with it.
 *
 * What this used to be: four unscoped DELETEs, one of them `DELETE FROM audit_log`. Re-running
 * `npm run seed` therefore erased every hold, every queued distro advisory and every audit row for
 * every package in the cluster, including ones the reseed had nothing to do with. A project whose
 * central claim is an append-only, atomically-written paper trail cannot ship a routine command
 * that quietly destroys it.
 *
 * Two changes. First, scope: only holds that actually CITE a playbook row are touched, because
 * those are the only ones the foreign key forces out; a hold with no matched arc is unrelated to
 * the corpus and survives. Second, consent: even those are refused by default while any exist,
 * because "your reseed is about to delete N holds" should be a decision, not a side effect.
 *
 * All of it in one transaction — a half-cleared corpus with the holds already gone is a worse
 * state than either end of the operation.
 */
export async function clearPlaybook(options: ClearPlaybookOptions = {}): Promise<void> {
  const force = options.force ?? process.env.SLEEPER_FORCE_CLEAR === '1'
  return withTransaction(async (client: PoolClient) => {
    const citing = await client.query<{ n: string }>(
      'SELECT count(*) AS n FROM release_hold WHERE matched_playbook_id IS NOT NULL',
    )
    const n = Number(citing.rows[0]!.n)

    if (n > 0 && !force) {
      throw new Error(
        `Refusing to clear the playbook: ${n} release hold(s) cite arcs in it, and the foreign ` +
          'key means clearing the corpus would delete those holds together with their advisories ' +
          'and audit rows. Reset the affected packages first (`npm run replay` calls ' +
          'resetPackage), or re-run with SLEEPER_FORCE_CLEAR=1 if losing that paper trail is ' +
          'genuinely what you want.',
      )
    }

    if (n > 0) {
      const scope = `(SELECT id FROM release_hold WHERE matched_playbook_id IS NOT NULL)`
      await client.query(`DELETE FROM audit_log WHERE release_hold_id IN ${scope}`)
      await client.query(`DELETE FROM distro_advisory_outbox WHERE release_hold_id IN ${scope}`)
      await client.query('DELETE FROM release_hold WHERE matched_playbook_id IS NOT NULL')
    }

    await client.query('DELETE FROM takeover_playbook')
  })
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

export type UnholdResult = {
  holdId: string
  packageId: string
  advisoryId: string
  auditId: string
  resolvedAt: Date
  /** Whether trust_state ended at 'cleared' or stayed 'held' because another hold is still open. */
  trustStatus: 'cleared' | 'held'
  writes: string[]
}

/**
 * The way out of a hold — the counterpart to `commitHold`, and just as atomic.
 *
 * Sleeper decides on behaviour, not on a proof of compromise, so it will hold releases that turn
 * out to be fine. `sql/schema.sql` advertised a 'cleared' trust status from day one and no code
 * path ever wrote it, which meant the first false positive blocked a package's releases
 * permanently — with an advisory already queued to Debian, Fedora and Arch and nothing anywhere
 * saying it had been withdrawn. A gate with no release valve is not a safety feature.
 *
 * Four writes, one transaction, the same all-or-nothing property the hold has, and for the same
 * reason: a cleared package whose retraction advisory never queued is a distro still shipping a
 * warning about a release nobody is holding any more.
 *
 * It never DELETEs. The hold row is updated in place with who cleared it, when and why, and a
 * second audit row is appended. "We held your release and then erased the evidence that we did"
 * is a worse story than the false positive it was covering up, and a packager auditing this later
 * needs to see both halves.
 */
export async function commitUnhold(
  holdId: string,
  resolvedBy: string,
  note: string,
): Promise<UnholdResult> {
  assertUuid(holdId)
  return withTransaction(async (client: PoolClient) => {
    // The `resolution IS NULL` guard makes this idempotent-safe rather than idempotent: a second
    // unhold of the same hold is refused instead of appending a second retraction advisory.
    const updated = await client.query<{ package_id: string; resolved_at: Date }>(
      `UPDATE release_hold
          SET resolution = 'cleared', resolved_by = $2, resolved_at = now(), resolution_note = $3
        WHERE id = $1 AND resolution IS NULL
        RETURNING package_id, resolved_at`,
      [holdId, resolvedBy, note],
    )
    const row = updated.rows[0]
    if (!row) {
      const existing = await client.query<{ resolution: string | null }>(
        'SELECT resolution FROM release_hold WHERE id = $1',
        [holdId],
      )
      if (!existing.rows[0]) throw new Error(`No release hold with id ${holdId}.`)
      throw new Error(
        `Hold ${holdId} is already resolved ('${existing.rows[0].resolution}') — resolution is ` +
          'recorded once and never overwritten.',
      )
    }
    const packageId = row.package_id

    // One package can be held by more than one release. Clearing this hold must not un-hold the
    // package while another open hold still stands, so the trust status follows the remaining
    // holds rather than this single decision.
    const open = await client.query<{ n: string }>(
      'SELECT count(*) AS n FROM release_hold WHERE package_id = $1 AND resolution IS NULL',
      [packageId],
    )
    const trustStatus: 'cleared' | 'held' = Number(open.rows[0]!.n) === 0 ? 'cleared' : 'held'
    await client.query(
      `INSERT INTO trust_state (package_id, status, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (package_id) DO UPDATE SET status = $2, updated_at = now()`,
      [packageId, trustStatus],
    )

    // A retraction is a new outbox row, not an edit to the original advisory: the first one may
    // already have been sent, and a distro that acted on it needs to receive the withdrawal.
    const advisory = await client.query<{ id: string }>(
      `INSERT INTO distro_advisory_outbox (release_hold_id, advisory_text)
       VALUES ($1, $2) RETURNING id`,
      [
        holdId,
        `RETRACTION — the hold on ${packageId} has been cleared after review by ${resolvedBy}. ` +
          `The earlier advisory for this hold is withdrawn and the release may proceed. ` +
          `Reason recorded: ${note}`,
      ],
    )

    const audit = await client.query<{ id: string }>(
      `INSERT INTO audit_log (release_hold_id, actor, action, detail)
       VALUES ($1, $2, 'unhold', $3) RETURNING id`,
      [holdId, resolvedBy, `cleared: ${note}`],
    )

    return {
      holdId,
      packageId,
      advisoryId: advisory.rows[0]!.id,
      auditId: audit.rows[0]!.id,
      resolvedAt: row.resolved_at,
      trustStatus,
      writes: [
        "UPDATE release_hold -> resolution 'cleared'",
        `UPDATE trust_state -> '${trustStatus}'`,
        'INSERT distro_advisory_outbox (retraction)',
        "INSERT audit_log (action 'unhold')",
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
    /** null while the hold stands; 'cleared' once `commitUnhold` has retracted it. */
    resolution: string | null
    resolvedBy: string | null
    resolvedAt: Date | null
    resolutionNote: string | null
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
        created_at::STRING AS created_at, matched_playbook_id,
        resolution, resolved_by, resolved_at::STRING AS resolved_at, resolution_note
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
const nullableDate = (v: unknown): Date | null => (v == null ? null : date(v))

/**
 * A payload that parsed as a row but is not the row the query asked for.
 *
 * Named, and carrying the offending column, because the alternative is what this project actually
 * shipped: the coercions above are total — `Number(undefined)` is `NaN`, `new Date('undefined')`
 * is an Invalid Date — so a row missing its columns produces a `HoldEvidence` object that looks
 * complete right up until `scripts/explain.ts` calls `.toISOString()` on it and a judge watches a
 * `RangeError: Invalid time value` land instead of an audit trail.
 */
export class MalformedRowError extends Error {
  constructor(
    readonly column: string,
    message: string,
  ) {
    super(message)
    this.name = 'MalformedRowError'
  }
}

/**
 * Rejects a `release_hold` row that cannot be trusted to describe a real hold.
 *
 * `parseRows` (src/mcp.ts) was hardened so a bare non-row object can no longer be fabricated into
 * a row, which closed the `{"error":"permission denied"}` case. It does not close the WRAPPED one:
 * `{"rows":[{...}]}` is a legitimate result-set encoding, and nothing about it guarantees the row
 * inside carries the columns `EVIDENCE_SQL.hold` selected. A server on a different schema version,
 * a proxy that projects a subset, a column renamed in the cluster — all arrive here as a row-shaped
 * object with holes in it.
 *
 * Three columns are checked because three are load-bearing downstream: `id` is what every later
 * statement cites, `created_at` is formatted as a Date, and `similarity` is printed to four decimal
 * places. `similarity` is rejected when it is null as well as when it coerces to `NaN` — the column
 * is NOT NULL in sql/schema.sql, so a null there means the payload is wrong, and letting it become
 * `0.0000` would report a confident-looking similarity that no query produced.
 *
 * Honest about the limit: this validates the hold row only. The advisory and audit rows are
 * rendered as strings and a missing column there degrades to an empty cell rather than to a crash,
 * so they are left tolerant deliberately rather than by omission.
 */
function assertHoldRow(row: Record<string, unknown>, holdId: string): void {
  const reject = (column: string, why: string): never => {
    throw new MalformedRowError(
      column,
      `The audit reader returned a release_hold row for ${holdId} whose \`${column}\` is unusable ` +
        `(${why}; got ${JSON.stringify(row[column]) ?? String(row[column])}). This is a result-set ` +
        `payload that parsed but does not carry the columns EVIDENCE_SQL.hold selected — the ` +
        `evidence is not rendered from it, because a half-read hold shown as fact is worse than ` +
        `an error naming the column.`,
    )
  }

  if (row.id == null || String(row.id).trim() === '') reject('id', 'missing or empty')
  if (row.created_at == null) reject('created_at', 'missing')
  if (Number.isNaN(date(row.created_at).getTime())) reject('created_at', 'not a parseable timestamp')
  if (row.similarity == null || !Number.isFinite(Number(row.similarity))) {
    reject('similarity', 'does not coerce to a finite number')
  }
}

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
  // No row is a legitimate answer — that hold id does not exist. A row that is present but
  // malformed is not, and it is the case the unchecked coercions below would hide.
  if (!row) return null
  assertHoldRow(row, holdId)

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
      resolution: nullableStr(row.resolution),
      resolvedBy: nullableStr(row.resolved_by),
      resolvedAt: nullableDate(row.resolved_at),
      resolutionNote: nullableStr(row.resolution_note),
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

/**
 * Wipes only what a replay owns, so the demo is idempotent and re-runnable in front of a judge.
 *
 * Six statements in ONE transaction. As six separate autocommitted statements, an interruption
 * partway through left a package with its events deleted but its holds intact, or — worse — with
 * `trust_state` never reset to 'trusted' while every hold that justified the 'held' status was
 * already gone. The demo would then open on a package that claims to be held and can produce no
 * hold to show for it, which is the single most damaging state this UI can be in.
 */
export async function resetPackage(packageId: string): Promise<void> {
  return withTransaction(async (client: PoolClient) => {
    const holds = `(SELECT id FROM release_hold WHERE package_id = $1)`
    await client.query(`DELETE FROM audit_log WHERE release_hold_id IN ${holds}`, [packageId])
    await client.query(`DELETE FROM distro_advisory_outbox WHERE release_hold_id IN ${holds}`, [
      packageId,
    ])
    await client.query('DELETE FROM release_hold WHERE package_id = $1', [packageId])
    await client.query('DELETE FROM actor_arcs WHERE package_id = $1', [packageId])
    await client.query('DELETE FROM events WHERE package_id = $1', [packageId])
    await client.query(
      `INSERT INTO trust_state (package_id, status, updated_at) VALUES ($1, 'trusted', now())
       ON CONFLICT (package_id) DO UPDATE SET status = 'trusted', updated_at = now()`,
      [packageId],
    )
  })
}
