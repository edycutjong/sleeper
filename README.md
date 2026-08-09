<div align="center">

<img src="docs/assets/icon.svg" width="96" alt="Sleeper" />

# Sleeper

### The release gate that remembers.

A release-gate agent whose multi-year memory of every commit, email and maintainer change
recognises a slow-motion supply-chain takeover — the xz backdoor pattern — that no single code
review can see, and atomically **holds** the poisoned release before it ships.

<img src="docs/assets/readme-hero.png" alt="Sleeper" width="820" />

<br />

[**Demo**](#-quick-start) · [**How it works**](#-how-it-works) · [**Reproduce the numbers**](DEMO.md) · [**Architecture**](#-architecture)

<br />

![CockroachDB](https://img.shields.io/badge/CockroachDB-Vector_Index-6933FF?style=flat-square)
![AWS Bedrock](https://img.shields.io/badge/AWS-Bedrock-FF9900?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?style=flat-square)
![Node](https://img.shields.io/badge/Node-%E2%89%A522-339933?style=flat-square)
![Tests](https://img.shields.io/badge/tests-61_passing-22C55E?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)

</div>

---

## 🕯️ The problem

On 2024-03-29 a backdoor was found in **xz-utils** ([CVE-2024-3094](https://nvd.nist.gov/vuln/detail/CVE-2024-3094)) — a
compression library running on essentially every Linux machine on Earth. It had been planted over
roughly two and a half years by a contributor who built trust one innocuous commit at a time:
real bug fixes, plausible mailing-list posts, patient helpfulness toward an exhausted sole
maintainer, two sockpuppet accounts pressuring him to hand over control, and finally release-signing
authority.

**No single commit was suspicious. No single code review could have caught it.** The tell only
existed in the *shape of the arc*: a new account's unusually fast rise, a concentration on build
machinery rather than library code, pressure accounts with no code that vanished the moment the
handover completed, and a maintainer who ended up reviewing his own release artifacts.

It was found five weeks after the poisoned tarball shipped, because one engineer got curious about
**500 ms of unexplained SSH login latency**. That is not a process. That is luck.

## 🌒 What Sleeper does

Sleeper watches a package the way no human reviewer can: continuously, for years, remembering
everything. When a release is about to go out, it rolls the actor's entire trajectory into one
behavioural arc, searches its own memory, compares that arc against known takeover shapes — and if
it matches, it **holds the release atomically**, with an audit trail a downstream distro packager
can query in one statement.

Replaying the real public xz timeline, Sleeper holds at the 5.6.0 upload — the moment the backdoor
actually shipped, and 35 days before the real world noticed.

> The xz replay is a ground-truth demo of a real incident, not a benchmark. Accuracy is measured
> separately, on held-out synthetic arcs, by `npm run bench`. The two are reported apart on
> purpose — see [DEMO.md](DEMO.md).

## 🧠 How it works

The premise is that **the memory layer is the product**. A 90-day slice of this attack is three
innocuous commits; the signal only exists across years of accumulated context. So the decision is
not made on the incoming event — it is made on what the incoming event means given everything
already in the database.

```mermaid
flowchart TD
    A["GitHub-webhook-shaped event<br/>(replayed xz timeline)"] --> B["AWS Lambda / demo server<br/>agent loop"]
    B --> C["Bedrock InvokeModel<br/>Titan Text Embeddings V2"]
    C --> D[("events<br/>VECTOR INDEX (package_id, embedding)")]
    D -->|"read history back OUT of the cluster"| E["Bedrock Converse (Claude)<br/>roll up the behavioural arc"]
    E --> F["Bedrock InvokeModel<br/>embed the arc"]
    F --> G[("actor_arcs<br/>VECTOR INDEX (package_id, embedding)")]
    G -->|"prefix-scoped<br/>WHERE package_id = $1 ORDER BY embedding <=> $2"| H{{"EXPLAIN proves<br/>prefix spans"}}
    G -->|"unscoped ORDER BY embedding <=> $1"| I[("takeover_playbook<br/>held_out excluded")]
    I --> J{"similarity ≥ threshold<br/>AND separated from benign?"}
    J -- no --> K["Release allowed, event archived"]
    J -- yes --> L["Bedrock Converse (Claude)<br/>compose rationale + advisory"]
    L --> M["ONE ACID TRANSACTION<br/>INSERT release_hold +<br/>UPDATE trust_state +<br/>INSERT distro_advisory_outbox +<br/>INSERT audit_log"]
    M --> N["Managed MCP Server<br/>select_query / explain_query / get_table_schema"]
    N --> O["Distro packager:<br/>'explain your hold'"]
```

Three details that matter:

**The agent never reads the seed file at decision time.** Events are ingested into CockroachDB,
and the arc is rebuilt by reading that history *back out of the cluster*, filtered to what was
knowable at the assessment timestamp. The database is the memory, not a log of it.

**The gate is two-sided.** A bare "similarity to a known takeover ≥ X" rule cries wolf on any
contributor who is new and prolific — which describes most good first-time maintainers. Sleeper
holds only when the arc is both close to a takeover shape *and* meaningfully closer to it than to
the nearest ordinary-contributor shape. Several benign arcs in the playbook are written to
superficially resemble takeovers (fast rise, handover, brand-new account) so that test has teeth.

**Structural signals are evidence, not votes.** Tenure, privilege-escalation speed, build-system
concentration and no-code pressure accounts are computed from memory and cited in the hold
rationale — but they do not participate in the decision. Mixing a hand-tuned rule engine into it
would quietly turn the benchmark into a measurement of the rules rather than of the memory.

## 🪐 CockroachDB tools used

| Tool | How it is used |
|---|---|
| **Distributed Vector Indexing** | Three inline `VECTOR INDEX` declarations (`sql/schema.sql`). `events` and `actor_arcs` are indexed on `(package_id, embedding vector_cosine_ops)` so ANN search is *prefix-scoped* to one package's own history; `takeover_playbook` is indexed unscoped, because a takeover shape learned anywhere must be matchable from anywhere. Retrieval uses `<=>` cosine ordering, and `EXPLAIN` is run on the live query to prove the `prefix spans` pre-filter — asserted in the test suite, not just claimed. |
| **ccloud CLI** | Provisions the Basic cluster and creates two service identities with different privilege scopes — `ingest_svc` (write path) and `gate_svc` (decision path). Access control is a demonstrated feature, not a footnote. See [DEMO.md §1](DEMO.md#provision-the-cluster-cockroachdb-ccloud-cli). |
| **Managed MCP Server** | ⚠️ **Not wired yet.** The "explain your hold" audit path exists today as direct SQL in `src/memory.ts` (`holdEvidence`) and `npm run explain`, which perform exactly the reads MCP's `select_query` / `explain_query` / `get_table_schema` would serve. Routing them through the Managed MCP Server is the next integration step; this row will describe working code or be removed before submission. |

The single ACID transaction is the reason this is CockroachDB and not a vector database bolted
onto a relational one: the vector search that produces the decision and the state change that acts
on it are the same system, so a hold can never half-land. There is no window where a release is
blocked with no advisory queued, or an advisory goes out for a hold that rolled back. That
invariant is tested by killing a transaction mid-write and asserting nothing survives.

## ☁️ AWS services used

| Service | How it is used |
|---|---|
| **Bedrock — Titan Text Embeddings V2** (`InvokeModel`) | Embeds every event on write and every arc summary before retrieval. 1024 dimensions, matching `VECTOR(1024)`. |
| **Bedrock — Claude** (`Converse`) | Rolls a multi-year event history into one behavioural arc summary, then composes the hold rationale and the distro advisory. |
| **Lambda** | Hosts the agent loop (`src/handler.ts`), webhook-triggered: one event arrives, is embedded, written, and assessed against everything already in memory. |

## 🚀 Quick start

```bash
npm install
cp .env.example .env          # DATABASE_URL + Bedrock model ids

npm run schema                # tables + vector indexes
npm run seed                  # playbook and held-out arc corpora
npm run calibrate             # fit thresholds on the playbook split only
npm start                     # http://localhost:3000 -> press "Replay the xz timeline"
```

Terminal equivalents: `npm run replay`, then `npm run explain -- --hold <uuid>`.

No AWS account? `SLEEPER_OFFLINE=1` swaps Bedrock for a deterministic stand-in so the schema, the
SQL, the vector indexes and the transaction semantics all run against a local CockroachDB node.
It proves the wiring and detects nothing — see [DEMO.md §4](DEMO.md#4-running-without-aws-credentials).

Full setup, reproduction steps and benchmark methodology: **[DEMO.md](DEMO.md)**.

## 🧪 Tests

**61 tests.** `npm test` runs the unit suite; the 15 integration tests activate when `DATABASE_URL`
is set and run against a real cluster, asserting the `prefix spans` plan line, held-out exclusion,
all-or-nothing hold transactions, and point-in-time correctness (a decision can never see an event
from after its own assessment timestamp).

## 📊 Benchmark

`npm run bench` reports recall@k, hold recall, false-positive rate and p50/p95 decision latency —
measured **only** on held-out arcs, against a lexical baseline, with the xz timeline excluded from
every figure. It refuses to run in offline mode. Results land in [DEMO.md](DEMO.md#results).

## 🛡️ Production readiness

- **Access control** — two service identities with distinct privilege scopes; MCP is read-only at
  the protocol layer even where the SQL identity can write.
- **Failure modes** — the hold is all-or-nothing under an explicit rollback test; the connection
  pool is closed per Lambda invocation because a socket held across an execution-context freeze
  comes back dead; a decision with no benign neighbour to contrast against refuses to hold rather
  than passing on a similarity score alone.
- **Point-in-time integrity** — every history read is bounded by the assessment timestamp, so a
  replay cannot leak hindsight into a past decision.
- **Auditability** — every hold carries the matched arc, the similarity, the threshold in force,
  the `EXPLAIN` verdict and the structural evidence, in queryable rows rather than in logs.
- **Honest thresholds** — fitted by leave-one-out on the playbook split, never on the evaluation
  set, and the fitted file is gitignored so a threshold from someone else's model cannot silently
  move the gate.

## 🚧 Not built (deliberately)

One package, one flow, done deeply. No multi-package dashboard, no user accounts, no Bedrock
Agents orchestration layer, no multi-region configuration, no second demo scenario. S3-backed
tarball diffing is described in the architecture but is not wired in this build.

Still to land before this is submission-complete: the Managed MCP Server integration (see the
table above) and a deployed Lambda — `src/handler.ts` is written and typechecked but has not been
deployed. Nothing in this README claims a capability the code does not have; where something is
pending it says so.

## 📄 License

MIT — see [LICENSE](LICENSE).

---

<div align="center">
<sub>Built for the CockroachDB × AWS Agentic Memory Hackathon.</sub>
</div>
