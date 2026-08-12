-- Sleeper — CockroachDB schema
--
-- Embedding width is 1024 = AWS Bedrock Titan Text Embeddings V2 default output dimension.
-- Vector indexes are declared INLINE in CREATE TABLE on purpose: backfilling a vector index on a
-- non-empty table blocks writes (documented CockroachDB limitation), so the index must exist before
-- the first row lands. The secondary (non-vector) indexes are declared inline for the same reason
-- of legibility, not necessity — they could be added later without blocking.
--
-- Two conventions worth stating once, because they are load-bearing everywhere below:
--
--  * Every column that carries a closed set of values has a CHECK. `label` in particular is read
--    back through an `as Label` cast in TypeScript, and a cast cannot fail at runtime — a row
--    labelled 'Takeover' would simply never match either side of the two-sided gate and the hold
--    would silently not fire. The database is the only place that mistake can be caught.
--  * Every table that stores a vector also stores WHICH model produced it. A 1024-dimension vector
--    from a different embedding model is indistinguishable from a good one by width alone, and
--    mixing two models in one cosine index produces confident nonsense rather than an error.

SET CLUSTER SETTING feature.vector_index.enabled = true;

-- Every raw signal Sleeper has ever seen for a package: one commit, one mailing-list post, one
-- maintainer change. Individually innocuous — that is the whole point of the attack.
CREATE TABLE IF NOT EXISTS events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  package_id STRING NOT NULL,
  actor_id STRING NOT NULL,
  -- src/signals.ts counts commits, emails, maintainer_changes and releases by exact string. A kind
  -- outside this set — a typo in a webhook payload, a new event type nobody taught the signal
  -- extractor about — would land in memory and be counted as none of them, quietly shrinking every
  -- ratio the arc is built from. Rejecting the insert is louder and cheaper than debugging that.
  kind STRING NOT NULL CHECK (kind IN ('commit', 'email', 'maintainer_change', 'release')),
  content STRING NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  source_url STRING,                    -- public citation for the event (auditability)
  -- Deterministic hash of (package_id, actor_id, kind, occurred_at, content) — see `eventKey`
  -- in src/memory.ts. Webhook delivery is at-least-once (API Gateway/Lambda retry by default),
  -- and a duplicated delivery would permanently double-weight one signal inside the very memory
  -- the hold decision is derived from. The uniqueness has to live in the database, because two
  -- concurrent deliveries can both pass an application-level "have I seen this?" check.
  event_key STRING NOT NULL,
  embedding VECTOR(1024) NOT NULL,
  embedding_model STRING NOT NULL,      -- Bedrock model id, or 'offline-fnv1a-1024' in offline mode
  embedding_dims INT NOT NULL,
  -- prefix column package_id: ANN search is pre-filtered to ONE package's own history.
  -- The index is used only when package_id is `=`-constrained — EXPLAIN proves it via `prefix spans`.
  VECTOR INDEX events_pkg_embedding_idx (package_id, embedding vector_cosine_ops),
  -- The two history reads (`actorHistory`, `packageHistory` in src/memory.ts) run on every single
  -- assessment and are ordered by time. Without these they are full scans of every package's
  -- entire history — the one access pattern this project cannot afford to be slow at, because the
  -- whole claim is that the multi-year arc is what makes the decision.
  --
  -- The STORING lists are the rest of each read's SELECT list, and they are not decoration. Key
  -- columns alone make the index findable but not sufficient: the plan was a `revscan` of the
  -- index followed by an `index join` back into events@events_pkey to fetch kind, content and
  -- source_url — up to SLEEPER_HISTORY_LIMIT (5,000) primary-key lookups per assessment, for rows
  -- the scan had already found. With the payload in the index both reads are covering and the
  -- `index join` node disappears from EXPLAIN entirely; tests/integration.test.ts asserts its
  -- absence, and CockroachDB's own `index recommendations:` line prints exactly these two lists.
  -- `id` needs no mention: it is the primary key, so every secondary index carries it already.
  --
  -- The cost is real and paid on write: `content` is now stored twice per event, so ingest writes
  -- more bytes and the table is meaningfully larger. That is the right way round only because of
  -- this workload's shape — one write per event, a full history read per assessment — and it would
  -- be the wrong trade for a table that is mostly written and rarely read back.
  --
  -- On a cluster created before this change, `CREATE TABLE IF NOT EXISTS` is a no-op and the old
  -- key-only indexes survive, so the covering-index test stays red until they are replaced. That
  -- does not require dropping `events` and losing its history — the indexes can be swapped in
  -- place, one at a time:
  --   DROP INDEX events@events_pkg_actor_time_idx;
  --   CREATE INDEX events_pkg_actor_time_idx ON events (package_id, actor_id, occurred_at)
  --     STORING (kind, content, source_url);
  --   DROP INDEX events@events_pkg_time_idx;
  --   CREATE INDEX events_pkg_time_idx ON events (package_id, occurred_at)
  --     STORING (actor_id, kind, content, source_url);
  INDEX events_pkg_actor_time_idx (package_id, actor_id, occurred_at) STORING (kind, content, source_url),
  -- actor_id is STORED here rather than keyed: the package-wide read selects it (it is how a
  -- no-history pressure account is spotted) but never constrains on it.
  INDEX events_pkg_time_idx (package_id, occurred_at) STORING (actor_id, kind, content, source_url),
  UNIQUE INDEX events_event_key_idx (event_key)
);

-- The rolling 90-day behavioural arc per actor: what the individual events add up to.
-- This is the unit of memory the decision is actually made on.
CREATE TABLE IF NOT EXISTS actor_arcs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  package_id STRING NOT NULL,
  actor_id STRING NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  event_count INT NOT NULL DEFAULT 0,
  arc_summary STRING NOT NULL,          -- Bedrock Claude (Converse) rollup of the window
  embedding VECTOR(1024) NOT NULL,
  embedding_model STRING NOT NULL,
  embedding_dims INT NOT NULL,
  VECTOR INDEX actor_arcs_pkg_embedding_idx (package_id, embedding vector_cosine_ops),
  -- "Exactly one rolling arc per actor" is an invariant the code asserts and the demo relies on.
  -- It belongs here: it is what lets the upsert be a single ON CONFLICT statement instead of a
  -- DELETE-then-INSERT pair that two concurrent assessments can interleave into two rows or none.
  UNIQUE INDEX actor_arcs_pkg_actor_key (package_id, actor_id)
);

-- The retrieval corpus an arc is compared AGAINST: reconstructed real takeover arcs plus
-- synthesised benign and takeover arcs. Deliberately UNSCOPED by package — a takeover shape learned
-- from one ecosystem must be matchable from any package.
CREATE TABLE IF NOT EXISTS takeover_playbook (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  package_id STRING NOT NULL,
  label STRING NOT NULL CHECK (label IN ('takeover', 'benign')),
  source STRING NOT NULL,               -- 'real-xz-timeline' | 'synthetic'
  held_out BOOL NOT NULL DEFAULT false, -- true = evaluation only, never used to tune thresholds
  arc_summary STRING NOT NULL,
  embedding VECTOR(1024) NOT NULL,
  embedding_model STRING NOT NULL,
  embedding_dims INT NOT NULL,
  -- held_out and embedding_model are index PREFIX columns, not WHERE-clause afterthoughts.
  --
  -- This is the query that makes the hold decision, and it is the one place where a post-filter is
  -- genuinely dangerous. An ANN index returns k candidates and only THEN gets filtered; with the
  -- filters outside the index, held-out arcs (which are half the corpus during evaluation) consume
  -- top-k slots and are thrown away afterwards. `decide()` needs BOTH a takeover and a benign
  -- neighbour to compute its margin, so a neighbourhood dense in held-out rows quietly returns a
  -- one-sided match, the margin collapses to zero, and the gate does not fire. A missed hold that
  -- looks exactly like a considered decision is the worst failure this system has.
  --
  -- With the prefix, CockroachDB descends only the held_out=false / matching-model subtree, so
  -- every one of the k candidates is a legal one. EXPLAIN prints `prefix spans: [/false/'…']`
  -- and tests/integration.test.ts asserts it.
  VECTOR INDEX takeover_playbook_embedding_idx (held_out, embedding_model, embedding vector_cosine_ops)
);

CREATE TABLE IF NOT EXISTS release_hold (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  package_id STRING NOT NULL,
  release_version STRING NOT NULL,
  reason STRING NOT NULL,               -- Bedrock Claude-composed hold rationale
  matched_playbook_id UUID REFERENCES takeover_playbook(id),
  similarity FLOAT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  -- The way out. A behavioural gate WILL produce false positives; without a recorded retraction
  -- path the first one blocks a package's releases forever, with an advisory already queued to
  -- Debian/Fedora/Arch and nothing on record saying it was withdrawn. Resolution is recorded, never
  -- deleted: `commitUnhold` in src/memory.ts updates these columns, flips trust_state, queues a
  -- retraction advisory and appends an audit row — all in one transaction. The hold row itself is
  -- append-only, because "we held your release and then quietly erased the evidence" is worse than
  -- the false positive.
  resolution STRING CHECK (resolution IS NULL OR resolution = 'cleared'),
  resolved_by STRING,
  resolved_at TIMESTAMPTZ,
  resolution_note STRING,
  -- Serves the "latest hold for this package" read on the demo server's state endpoint.
  INDEX release_hold_pkg_time_idx (package_id, created_at DESC)
);

CREATE TABLE IF NOT EXISTS trust_state (
  package_id STRING PRIMARY KEY,
  status STRING NOT NULL CHECK (status IN ('trusted', 'held', 'cleared')),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS distro_advisory_outbox (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  release_hold_id UUID REFERENCES release_hold(id),
  advisory_text STRING NOT NULL,
  sent BOOL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  -- CockroachDB does not create an index on a FK's REFERENCING column, and the entire evidence
  -- read (`EVIDENCE_SQL` in src/memory.ts) looks rows up by exactly this column. Without it,
  -- "explain your hold" full-scans the outbox.
  INDEX advisory_hold_idx (release_hold_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  release_hold_id UUID REFERENCES release_hold(id),
  actor STRING NOT NULL,                -- 'agent' | MCP caller identity
  action STRING NOT NULL,               -- 'hold' | 'unhold'
  detail STRING,
  created_at TIMESTAMPTZ DEFAULT now(),
  INDEX audit_hold_idx (release_hold_id)
);
