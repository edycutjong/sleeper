# Sleeper — demo, reproduction and results

Two separate things live in this file, and they are kept apart on purpose:

1. **The xz replay** — a ground-truth walk through a real, public, documented incident. It is
   evidence that the mechanic recognises the actual xz takeover. It is *not* a measurement.
2. **The benchmark** — accuracy and latency measured only on held-out synthetic arcs the system
   never retrieves from and that no threshold was fitted on.

Blurring the two would let a single anecdote masquerade as a detection rate. The xz timeline
contributes nothing to any number in the results table below.

---

## 1. Setup

### Prerequisites

- Node.js ≥ 22
- A CockroachDB cluster with vector indexing available (Cloud Basic, or a local v25.2+ node)
- An AWS account with Bedrock model access granted for Titan Text Embeddings V2 and a Claude model

### Provision the cluster (CockroachDB `ccloud` CLI)

```bash
ccloud auth login
ccloud cluster create basic sleeper-cluster --cloud GCP --spend-limit 0

# Two service identities with different privilege scopes — see "Access control" in README.md.
ccloud cluster user create sleeper-cluster ingest_svc
ccloud cluster user create sleeper-cluster gate_svc

ccloud cluster sql --connection-url sleeper-cluster   # -> DATABASE_URL
```

### Configure and load

```bash
cp .env.example .env       # fill in DATABASE_URL and the Bedrock model ids
npm install

npm run schema             # creates the tables and the three vector indexes
npm run seed               # loads the playbook + held-out arc corpora
npm run calibrate          # fits hold thresholds on the playbook split ONLY
```

`npm run calibrate` writes `data/thresholds.json`. That file is deliberately **not** committed: a
thresholds file fitted against a different embedding model would silently change where the gate
sits.

---

## 2. The hero replay

```bash
npm run replay      # terminal
npm start           # browser: http://localhost:3000, press "Replay the xz timeline"
```

Both drive the same agent loop in `src/agent.ts`. The replay:

1. Streams 25 events from the public CVE-2024-3094 timeline into `events`, embedding each one
   through Bedrock on the way in.
2. At each release event, reads the actor's history **back out of CockroachDB** (never out of the
   seed file), rolls it into a 90-day behavioural arc via Bedrock Claude, and embeds the arc.
3. Runs the prefix-scoped ANN query over this package's own memory and prints `EXPLAIN`. The
   `prefix spans: [/'xz-utils' - /'xz-utils']` line in that plan is the proof the search was
   bounded to one package by the leading vector-index column rather than scanning globally.
4. Runs the unscoped ANN query against the takeover playbook.
5. If the decision trips, commits the hold as **one transaction**: `INSERT release_hold` +
   `UPDATE trust_state` + `INSERT distro_advisory_outbox` + `INSERT audit_log`.

Then audit the result the way a downstream distro packager would:

```bash
npm run explain                     # re-run EXPLAIN, show the plan and the nearest events
npm run explain -- --hold <uuid>    # full evidence trail behind a specific hold
```

### What the replay is and is not

The xz timeline in `data/xz-timeline.json` is reconstructed from public sources (the
tukaani-project git history, xz-devel archives, oss-fuzz pull requests, and Andres Freund's
2024-03-29 oss-security disclosure), cited per event in `source_url`. Events whose exact date is
only known to within a window are marked `approximate: true`.

The playbook the arc is matched against contains **no xz-derived arc**. Matching the xz arc
against a corpus containing the xz arc would prove nothing.

---

## 3. Benchmark

```bash
npm run bench
```

Measured on the held-out split only (`held_out = true`), which is excluded from every retrieval
query the agent runs and was not visible to `npm run calibrate`. A lexical baseline — hashed
bag-of-words cosine over the same queries, same decision rule — runs alongside, because a
similarity score means nothing without knowing what keyword matching alone would have scored.

The script refuses to run with `SLEEPER_OFFLINE=1`, since a quality number computed on a hash
function would be a property of the hash function.

### Results

<!-- BENCH:START -->

_Not yet generated. Run `npm run bench` against a live cluster with Bedrock credentials and this
block will be replaced with the measured table._

<!-- BENCH:END -->

---

## 4. Running without AWS credentials

`SLEEPER_OFFLINE=1` swaps Bedrock for a deterministic hashed bag-of-words stand-in so the schema,
the SQL, the vector-index behaviour, the transaction semantics and the agent loop can all be
exercised on a local cluster with no AWS account:

```bash
cockroach start-single-node --insecure --listen-addr=localhost:26257 --store=/tmp/sleeper-crdb
cockroach sql --insecure -e 'CREATE DATABASE sleeper'

export DATABASE_URL='postgresql://root@localhost:26257/sleeper?sslmode=disable'
export SLEEPER_OFFLINE=1
npm run schema && npm run seed && npm run calibrate && npm run replay
```

**This mode does not detect anything.** A hash carries no notion of what a takeover arc means, so
it cannot separate one from an ordinary contributor, and the replay ends with the gate open. It
proves the wiring, nothing more. Every entry point prints which inference path it is on, and
`npm run bench` refuses to run at all.

---

## 5. Tests

```bash
npm test          # unit tests only; integration tests skip without DATABASE_URL
DATABASE_URL='postgresql://root@localhost:26257/sleeper?sslmode=disable' npm test
```

61 tests. The integration suite runs against a real cluster and asserts, among other things:

- `EXPLAIN` on the scoped query contains `prefix spans` and names the vector index
- held-out arcs are never returned by any retrieval the agent performs
- a hold commits all four writes, and `holdEvidence` returns the complete trail
- a failure mid-transaction leaves **no** partial state — no blocked release with an orphaned
  advisory, no advisory for a hold that rolled back

They namespace every row to a per-run package id and tear it down afterwards, so they are safe to
point at the same cluster as the demo.

---

## 6. Deploying the agent loop to Lambda

`src/handler.ts` exports the same loop as two handlers:

- `ingestHandler` — one webhook-shaped event arrives, is embedded, written, and assessed against
  everything already in memory. This is the production shape: a single innocuous event can trip
  the gate because the memory it lands in is years deep.
- `replayHandler` — replays the bundled corpus to warm a fresh cluster.

The function needs `bedrock:InvokeModel` and `bedrock:Converse`, outbound access to the cluster,
and `DATABASE_URL` from Secrets Manager or an encrypted environment variable — never from the
repo. The pool is closed on the way out of every invocation, because Lambda freezes the execution
context between calls and a socket left open across a freeze comes back dead.

---

## 7. Demo video script (< 3 min)

| Time | Beat |
|---|---|
| 0:00–0:15 | xz in one sentence: two years of trust-building, caught five weeks late because of 500 ms of SSH latency. |
| 0:15–0:45 | Press **Replay**. Events stream in; the counter climbs as rows land in CockroachDB. |
| 0:45–1:30 | The 5.6.0 release event. Arc computed, `EXPLAIN` on screen, `prefix spans` highlighted. |
| 1:30–2:00 | Playbook match, decision, then the HOLD panel: one transaction, four writes, one COMMIT. |
| 2:00–2:30 | `npm run explain -- --hold <id>` — the evidence trail a distro packager reads. Then `npm run bench` output, labelled as held-out and separate from the replay. |
| 2:30–2:45 | On-screen text: CockroachDB tools used (Distributed Vector Indexing, Managed MCP Server, ccloud CLI) and AWS services used (Bedrock Titan, Bedrock Claude, Lambda). |
| 2:45–3:00 | "The real world found this 35 days later, by luck." |
