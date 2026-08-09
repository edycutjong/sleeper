-- Sleeper — CockroachDB schema
--
-- Embedding width is 1024 = AWS Bedrock Titan Text Embeddings V2 default output dimension.
-- Vector indexes are declared INLINE in CREATE TABLE on purpose: backfilling a vector index on a
-- non-empty table blocks writes (documented CockroachDB limitation), so the index must exist before
-- the first row lands.

SET CLUSTER SETTING feature.vector_index.enabled = true;

-- Every raw signal Sleeper has ever seen for a package: one commit, one mailing-list post, one
-- maintainer change. Individually innocuous — that is the whole point of the attack.
CREATE TABLE IF NOT EXISTS events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  package_id STRING NOT NULL,
  actor_id STRING NOT NULL,
  kind STRING NOT NULL,                 -- 'commit' | 'email' | 'maintainer_change' | 'release'
  content STRING NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  source_url STRING,                    -- public citation for the event (auditability)
  embedding VECTOR(1024) NOT NULL,
  -- prefix column package_id: ANN search is pre-filtered to ONE package's own history.
  -- The index is used only when package_id is `=`-constrained — EXPLAIN proves it via `prefix spans`.
  VECTOR INDEX events_pkg_embedding_idx (package_id, embedding vector_cosine_ops)
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
  VECTOR INDEX actor_arcs_pkg_embedding_idx (package_id, embedding vector_cosine_ops)
);

-- The retrieval corpus an arc is compared AGAINST: reconstructed real takeover arcs plus
-- synthesised benign and takeover arcs. Deliberately UNSCOPED — a takeover shape learned from one
-- ecosystem must be matchable from any package.
CREATE TABLE IF NOT EXISTS takeover_playbook (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  package_id STRING NOT NULL,
  label STRING NOT NULL,                -- 'takeover' | 'benign'
  source STRING NOT NULL,               -- 'real-xz-timeline' | 'synthetic'
  held_out BOOL NOT NULL DEFAULT false, -- true = evaluation only, never used to tune thresholds
  arc_summary STRING NOT NULL,
  embedding VECTOR(1024) NOT NULL,
  VECTOR INDEX takeover_playbook_embedding_idx (embedding vector_cosine_ops)
);

CREATE TABLE IF NOT EXISTS release_hold (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  package_id STRING NOT NULL,
  release_version STRING NOT NULL,
  reason STRING NOT NULL,               -- Bedrock Claude-composed hold rationale
  matched_playbook_id UUID REFERENCES takeover_playbook(id),
  similarity FLOAT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trust_state (
  package_id STRING PRIMARY KEY,
  status STRING NOT NULL,               -- 'trusted' | 'held' | 'cleared'
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS distro_advisory_outbox (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  release_hold_id UUID REFERENCES release_hold(id),
  advisory_text STRING NOT NULL,
  sent BOOL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  release_hold_id UUID REFERENCES release_hold(id),
  actor STRING NOT NULL,                -- 'agent' | MCP caller identity
  action STRING NOT NULL,
  detail STRING,
  created_at TIMESTAMPTZ DEFAULT now()
);
