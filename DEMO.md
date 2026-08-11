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
./scripts/provision.sh --dry-run   # every command it would run, printed, nothing touched
./scripts/provision.sh             # cluster + database + the two SQL identities
```

The `ccloud` commands live in `scripts/provision.sh` and nowhere else, on purpose. This file used
to carry its own copy of the cluster-create line and it had drifted into a flag that does not
exist (`--spend-limit`), which is what a second source of truth costs you. `--dry-run` prints
every command the script would run, so it doubles as the documentation this section used to be.

The script finishes by printing which of the two identities runs which command. That mapping is
not cosmetic — the setup commands below need privileges the running agent is deliberately denied.

### Configure and load

```bash
cp .env.example .env       # fill in DATABASE_URL and the Bedrock model ids
npm install

# Setup runs as sleeper_admin: these create tables, set a cluster setting, and DELETE rows.
export DATABASE_URL='<the sleeper_admin connection URL>'
npm run schema             # creates the tables and the three vector indexes
./scripts/provision.sh     # re-run now the tables exist, to apply the per-table grants
npm run seed               # loads the playbook + held-out arc corpora
npm run calibrate          # fits hold thresholds on the playbook split ONLY
```

Leave `DATABASE_URL` on `sleeper_admin` for §2 — `npm run replay` and the demo server's replay
button both reset the package's memory first. The `gate_svc` URL is what a *deployed* Sleeper
uses: it can hold a release and clear a hold, and can delete nothing.

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

## 2b. What the packager receives

Everything above this line is mechanism. This section is the product: the notice a downstream
distribution maintainer actually opens when their release stops.

There is a problem with showing it. The hold rationale and the distro advisory are the two fields
Bedrock Claude composes (`src/agent.ts`, `RATIONALE_SYSTEM`), and in `SLEEPER_OFFLINE=1` the gate
correctly never reaches a hold at all — §4 says why. So without an AWS account there was nothing
to look at: no notice, no advisory, no evidence trail.

`npm run notice` closes that without faking a detection.

```bash
export DATABASE_URL='postgresql://root@localhost:26257/sleeper?sslmode=disable'
export SLEEPER_OFFLINE=1
npm run schema && npm run seed && npm run calibrate
npm run notice                       # ingest, assess, then commit a labelled preview hold
npm run explain -- --hold <uuid>     # the trail, read back the way a packager reads it
npm run notice -- --clean            # drop the preview lane's rows from the cluster
```

It runs the real agent loop over the same 25-event xz timeline, prints the gate's own decision
(ALLOW — the correct offline outcome), and then **deliberately** commits a hold through the real
`commitHold` so the output format is inspectable. It is not a detection and it says so, at the top
of the output, at the bottom of the output, and inside the two stored prose fields themselves — so
the label survives being read back out of the database by `npm run explain`.

### Real vs templated, field by field

| Part of the notice | Real or templated |
|---|---|
| The `commitHold` transaction — 4 writes, 1 COMMIT, all-or-nothing | **Real** — the same function the gate calls |
| `release_hold`, `trust_state`, `distro_advisory_outbox`, `audit_log` rows | **Real** — written to CockroachDB |
| Hold id, advisory id, audit id, `created_at` | **Real** — assigned by the cluster |
| Candidate ranking and the account the release is judged on | **Real** — enumerated from the package's own memory, nothing pinned |
| Prefix-scoped `EXPLAIN` plan and `prefix spans` line | **Real** — from the cluster |
| Similarity `0.4865`, margin `-0.0595`, matched arc `syn-takeover-01` | **Real** — from the offline vector search, which is a hash (§4), so they are *real values with no quality meaning* |
| The gate's decision line (ALLOW) | **Real** — the gate's actual verdict on this run |
| Structural evidence lines | **Real** — computed by `src/signals.ts` from stored rows |
| The evidence-trail format and read path | **Real** — rendered exactly as `scripts/explain.ts` renders it |
| **`release_hold.reason` wording** | **TEMPLATED** — Bedrock composes it; no credentials here |
| **`distro_advisory_outbox.advisory_text` wording** | **TEMPLATED** — same reason |

Two prose fields are templated. Nothing else on this page is.

### Preview lane, not the demo lane

The hold is committed against the package id `xz-utils-notice-preview`, never `xz-utils`. A
deliberate hold on the hero replay's package would flip its `trust_state` to `held` and drop a
preview row into the middle of the real demo's evidence. The lane name is visible in every line of
the output below, so a reader can tell from the package id alone which lane this is, and
`npm run notice -- --clean` removes it.

### Transcript — `npm run notice`

Captured verbatim on 2026-08-11 against a local single-node CockroachDB with `SLEEPER_OFFLINE=1`.
Structured logs go to stderr and are omitted here for readability; one of them is quoted after the
transcript.

```

> sleeper@0.1.0 notice
> tsx scripts/notice.ts

════════════════════════════════════════════════════════════════════════════════
  OFFLINE NOTICE PREVIEW — READ BEFORE READING ANYTHING BELOW
════════════════════════════════════════════════════════════════════════════════
  The transaction, the rows, the ids, the evidence trail and the format are REAL
  and were produced by the real code path against a real CockroachDB cluster.

  The rationale and advisory WORDING is TEMPLATED, because Bedrock Claude
  composes those two fields and no AWS credentials are configured here.

  THIS IS NOT A DETECTION. The gate did not decide to hold. This hold was
  committed DELIBERATELY, by this script, so that the notice a distro packager
  receives is inspectable without an AWS account. No number on this page is a
  measurement, and no line of it is evidence that anything was caught.
════════════════════════════════════════════════════════════════════════════════

preview lane:  xz-utils-notice-preview  (never xz-utils — see scripts/notice.ts)
timeline:      the public CVE-2024-3094 xz-utils reconstruction, 25 events
inference: OFFLINE deterministic stand-in (SLEEPER_OFFLINE=1) — wiring only, no quality claims
thresholds:    calibrated (playbook split only, leave-one-out) holdAt=0.3695 minMargin=-0.0198

──────────────────────────────────────────────────────────────────────────────
STEP 1 — THE REAL AGENT LOOP, INGESTING THE xz TIMELINE INTO COCKROACHDB
──────────────────────────────────────────────────────────────────────────────
Memory reset for xz-utils-notice-preview.
  + [ 1/25] 2021-06-15 commit            lasse-collin   Routine solo maintenance on xz-utils by the long-tim…  (7ms)
  + [ 2/25] 2021-10-29 email             jia-tan        First recorded public activity of the JiaT75 account…  (9ms)
  + [ 3/25] 2022-04-19 email             jia-tan        Submits a patch to the xz-devel mailing list. The pa…  (6ms)
  + [ 4/25] 2022-04-22 email             jigar-kumar    An account with no prior history in the project appe…  (6ms)
  + [ 5/25] 2022-05-05 commit            jia-tan        Continues submitting genuinely useful patches. Code …  (6ms)
  + [ 6/25] 2022-05-19 email             jigar-kumar    Escalates pressure on the mailing list: 'Patches spe…  (7ms)
  + [ 7/25] 2022-06-07 email             jigar-kumar    Directly demands a maintainer handover: 'Progress wi…  (5ms)
  + [ 8/25] 2022-06-08 email             lasse-collin   The maintainer replies under pressure, disclosing pe…  (7ms)
  + [ 9/25] 2022-06-14 email             dennis-ens     A second account with no prior project history joins…  (6ms)
  + [10/25] 2022-06-21 email             jigar-kumar    Final recorded message from this account, still on t…  (9ms)
  + [11/25] 2022-09-27 commit            jia-tan        Sustained, high-quality contribution continues throu…  (6ms)
  + [12/25] 2022-11-30 maintainer_change jia-tan        Gains direct commit access to the xz-utils repositor…  (6ms)
  + [13/25] 2023-01-11 commit            jia-tan        First self-merged commits land on master. Content is…  (6ms)
  + [14/25] 2023-03-20 maintainer_change jia-tan        Changes the primary contact address registered with …  (6ms)
  + [15/25] 2023-05-04 release           jia-tan        Signs and publishes an xz-utils release as the actin…  (6ms)
    ↳ release 2023-05-04 assessed → ALLOW (similarity 0.4531, margin -0.0583)
  + [16/25] 2023-06-27 commit            hans-jansen    An account with no meaningful prior history contribu…  (6ms)
  + [17/25] 2023-07-08 commit            jia-tan        Opens a pull request against google/oss-fuzz to disa…  (10ms)
  + [18/25] 2023-07-19 commit            jia-tan        Disables Landlock sandboxing support through a delib…  (6ms)
  + [19/25] 2023-11-28 commit            jia-tan        Ordinary maintenance continues over the autumn: vers…  (6ms)
  + [20/25] 2024-02-23 commit            jia-tan        Commits 'Tests: Add a few test files.' adding binary…  (6ms)
  + [21/25] 2024-02-24 release           jia-tan        Publishes the xz-utils 5.6.0 release tarball. The ta…  (6ms)

──────────────────────────────────────────────────────────────────────────────
CANDIDATE SELECTION — nobody named the account under assessment
──────────────────────────────────────────────────────────────────────────────
  5 actors have events in this package's memory.
  5 actor(s) in this package's memory, ranked by structural signals; top 3 assessed, with the event's own actor (jia-tan) always included
    → jia-tan        score 0.7865
    → dennis-ens     score 0.3745
    → jigar-kumar    score 0.3723
      lasse-collin   score 0.3596
      hans-jansen    score 0.3401

──────────────────────────────────────────────────────────────────────────────
ACTOR ARC — jia-tan  (assessment at release 5.6.0)
──────────────────────────────────────────────────────────────────────────────
  window 2023-11-26 → 2024-02-24  (3 events in window, 13 cumulative)

  [OFFLINE STAND-IN — not model output] Behavioural arc reconstructed from 16 recorded events. Actor first public activity: 2021-10-29 (848 days before this assessment) Privilege changes on record: 2 Releases produced by this actor: 2 Share of commits touching build/CI machinery: 43% Other accounts arguing for the handover without contributing code: jigar-kumar, dennis-ens 2022-04-19 [email] Submits a patch to the xz-devel mailing list. The patch is small, plausible and technic… [clipped for display at 480 chars — the full text is in the row]

  Structural evidence held in memory:
    - Actor "jia-tan" has 13 recorded events over 848 days of tenure (first seen 2021-10-29).
    - Trust escalated to a privileged role 188 days after first public activity.
    - 43% of this actor's commits touch build or CI machinery rather than library code — the layer that ships in release tarballs but is least reviewed.
    - This actor now produces signed release artifacts (2 on record), so the artifact and its reviewer are the same party.
    - 2 account(s) with no code contributions (jigar-kumar, dennis-ens) argued for the maintainer handover and then stopped participating.

──────────────────────────────────────────────────────────────────────────────
PREFIX-SCOPED VECTOR SEARCH — EXPLAIN (the memory layer at work)
──────────────────────────────────────────────────────────────────────────────
  distribution: local
  
  • filter
  │ estimated row count: 20
  │ filter: embedding_model = 'offline-fnv1a-1024'
  │
  └── • top-k
      │ estimated row count: 20
      │ order: +distance
      │ k: 20
      │
      └── • render
          │
          └── • lookup join
              │ table: events@events_pkey
              │ equality: (id) = (id)
              │ equality cols are key
              │
              └── • vector search
                    table: events@events_pkg_embedding_idx
                    target count: 20
                    prefix spans: [/'xz-utils-notice-preview' - /'xz-utils-notice-preview']

  vector index used: YES   prefix-scoped to this package: YES

  Nearest events in this package's own memory:
    0.6743  2024-02-24 [release] Publishes the xz-utils 5.6.0 release tarball. The …
    0.5489  2022-09-27 [commit] Sustained, high-quality contribution continues thr…
    0.5315  2024-02-23 [commit] Commits 'Tests: Add a few test files.' adding bina…
    0.5212  2023-03-20 [maintainer_change] Changes the primary contact address registered wit…
    0.4906  2022-11-30 [maintainer_change] Gains direct commit access to the xz-utils reposit…

──────────────────────────────────────────────────────────────────────────────
UNSCOPED PLAYBOOK MATCH
──────────────────────────────────────────────────────────────────────────────
  1. syn-benign-01        benign    similarity 0.5460
  2. syn-benign-04        benign    similarity 0.4926
  3. syn-takeover-01      takeover  similarity 0.4865
  4. syn-benign-03        benign    similarity 0.4357
  5. syn-takeover-02      takeover  similarity 0.4272

──────────────────────────────────────────────────────────────────────────────
THE GATE'S OWN DECISION — release 5.6.0
──────────────────────────────────────────────────────────────────────────────
  ALLOW  (45ms from ingest)
  Similarity 0.4865 clears the threshold, but the arc is nearly as close to an ordinary contributor arc (margin -0.0595 < -0.019821238511858907) — not separable enough to justify holding a release.
  thresholds: holdAt 0.36947391406509944 / minMargin -0.019821238511858907
  + [22/25] 2024-03-01 email             hans-jansen    Files a Debian bug requesting that the distribution …  (6ms)
  + [23/25] 2024-03-09 release           jia-tan        Publishes 5.6.1, refining the backdoor after the 5.6…  (6ms)
    ↳ release 5.6.1 assessed → ALLOW (similarity 0.4686, margin -0.0701)
  + [24/25] 2024-03-25 email             jia-tan        Continues to press distributions to adopt 5.6.x, sup…  (7ms)
  + [25/25] 2024-03-29 email             andres-freund  Discloses the backdoor on oss-security after investi…  (6ms)

──────────────────────────────────────────────────────────────────────────────
STEP 2 — WHAT JUST HAPPENED, STATED PLAINLY
──────────────────────────────────────────────────────────────────────────────
  The gate assessed release 5.6.0 — judging it on "jia-tan", a candidate
  it selected itself out of 3 it ranked — and ALLOWED it.
  Similarity 0.4865 clears the threshold, but the arc is nearly as close to an ordinary contributor arc (margin -0.0595 < -0.019821238511858907) — not separable enough to justify holding a release.

  That is the correct offline outcome. The offline embedder is a hashed bag-of-words: it
  carries no sense of what a takeover arc means, so it cannot separate one from an
  ordinary contributor. No detection has occurred and none is claimed.

  What follows is therefore a DELIBERATE hold, committed by this script, for one reason
  only: so the notice a distro packager receives can be read without AWS credentials.

──────────────────────────────────────────────────────────────────────────────
STEP 3 — COMMITTING THE PREVIEW HOLD (the real `commitHold`, one transaction)
──────────────────────────────────────────────────────────────────────────────
  release_hold id: 1b261347-940a-4d41-ac1e-dfc5168b0a66
  advisory id:     b1092d89-ce98-4f66-ab20-86d909e9a86a
  audit id:        a19f96f0-a6aa-42d9-8873-a04d04785c85
  committed at:    2026-08-11T22:20:24.465Z
  ONE transaction, 4 writes, all-or-nothing:
    - INSERT release_hold
    - UPDATE trust_state -> 'held'
    - INSERT distro_advisory_outbox
    - INSERT audit_log

  Real: the transaction, the four rows, the ids above, the similarity 0.4865 and the
  matched playbook arc — every one of them produced by the real code path.
  Templated: the two prose fields, and they say so in their own stored text.

──────────────────────────────────────────────────────────────────────────────
STEP 4 — THE EVIDENCE TRAIL, AS `npm run explain -- --hold <uuid>` RENDERS IT
──────────────────────────────────────────────────────────────────────────────
AUDIT PATH: direct SQL over the pg pool — NOT the Managed MCP Server
            reason: COCKROACH_MCP_API_KEY is not set — no CockroachDB Cloud service-account key to authenticate with

──────────────────────────────────────────────────────────────────────────────
HOLD 1b261347-940a-4d41-ac1e-dfc5168b0a66
──────────────────────────────────────────────────────────────────────────────
  package:   xz-utils-notice-preview
  version:   5.6.0
  committed: 2026-08-11T22:20:24.465Z
  similarity to nearest known takeover shape: 0.4865
  package trust status now: held

──────────────────────────────────────────────────────────────────────────────
WHY
──────────────────────────────────────────────────────────────────────────────
  [TEMPLATED TEXT — NOT MODEL OUTPUT] In a credentialed run Bedrock Claude composes this field
  (src/agent.ts, RATIONALE_SYSTEM). Bedrock is not configured here, so the sentences are
  fixed; the numbers, ids and observations inside them are the real ones this run produced.
  
  PROVENANCE — this hold is NOT a detection. It was committed deliberately by `npm run notice`
  (scripts/notice.ts) so the notice format is inspectable without AWS credentials. The gate's
  own decision on this run was ALLOW: "Similarity 0.4865 clears the threshold, but the arc is
  nearly as close to an ordinary contributor arc (margin -0.0595 < -0.019821238511858907) —
  not separable enough to justify holding a release."
  
  Release xz-utils-notice-preview 5.6.0 is paused pending review of the publishing account's
  behavioural arc.
  
  What the memory layer observed:
  - Actor "jia-tan" has 13 recorded events over 848 days of tenure (first seen 2021-10-29).
  - Trust escalated to a privileged role 188 days after first public activity.
  - 43% of this actor's commits touch build or CI machinery rather than library code — the
    layer that ships in release tarballs but is least reviewed.
  - This actor now produces signed release artifacts (2 on record), so the artifact and its
    reviewer are the same party.
  - 2 account(s) with no code contributions (jigar-kumar, dennis-ens) argued for the
    maintainer handover and then stopped participating.
  
  How that arc was retrieved: 25 events for this package were read back out of CockroachDB as
  of 2024-02-24. The account under assessment was not configured — 3 candidate(s) (jia-tan,
  dennis-ens, jigar-kumar) were ranked out of the package's own memory and assessed
  independently; this release is judged on "jia-tan". That account's history was rolled into a
  90-day arc, embedded, and searched against this package's own memory with an ANN query
  bounded by the leading vector-index column (EXPLAIN prefix-scoped: YES). The same arc vector
  was then matched, unscoped, against the takeover playbook.
  
  Nearest known takeover shape: syn-takeover-01 at cosine similarity 0.4865. Nearest
  ordinary-contributor shape: syn-benign-01 — a separation of -0.0595. Thresholds in force:
  holdAt 0.36947391406509944, minMargin -0.019821238511858907.
  
  What to check before clearing: the provenance of the release tarball against the tag it
  claims to build from; who reviewed the build-system changes in the release branch; whether
  the accounts that argued for the handover can be tied to any code contribution anywhere.
  
  This is a behavioural hold, not a confirmed vulnerability. Clear it with `npm run unhold --
  --hold <id> --by <who> --note "<why>"`, which appends the reversal rather than deleting this
  row.

──────────────────────────────────────────────────────────────────────────────
MATCHED PLAYBOOK ARC — syn-takeover-01 (takeover)
──────────────────────────────────────────────────────────────────────────────
  source: synthetic

  A contributor with no prior public history begins submitting small, competent patches to a long-neglected library. Within months they are the most responsive participant. Two other accounts, also with no history, appear on the mailing list and push the exhausted sole maintainer to hand over control, contributing no code themselves. The maintainer names the new contributor as successor. Commit access follows, then release-signing authority. The pressure accounts fall silent im… [clipped for display at 480 chars — the full text is in the row]

──────────────────────────────────────────────────────────────────────────────
DISTRO ADVISORIES QUEUED
──────────────────────────────────────────────────────────────────────────────
  [queued] b1092d89-ce98-4f66-ab20-86d909e9a86a
  [TEMPLATED TEXT — NOT MODEL OUTPUT] Bedrock Claude composes this field in a credentialed
  run; the wording below is a fixed template. NOT A DETECTION — committed deliberately by
  scripts/notice.ts.
  
  ADVISORY — xz-utils-notice-preview 5.6.0 HELD
  
  Downstream packagers (Debian, Fedora, Arch): do not promote xz-utils-notice-preview 5.6.0
  into a distribution channel while this hold stands.
  
  Reason: the publishing account's multi-year behavioural arc matches a known
  maintainer-takeover shape (syn-takeover-01, cosine similarity 0.4865, separation from the
  nearest ordinary-contributor arc -0.0595).
  
  Recommended action: keep the previous release in place, rebuild from the tagged source
  rather than the published tarball if you need the version, and ask the project to name a
  second reviewer for the release artifact.
  
  This hold is BEHAVIOURAL, not a confirmed vulnerability. No exploit has been demonstrated
  and no CVE is claimed. It may be withdrawn; a retraction advisory is queued to this same
  outbox if it is.


──────────────────────────────────────────────────────────────────────────────
AUDIT TRAIL
──────────────────────────────────────────────────────────────────────────────
  2026-08-11T22:20:24.465Z  agent  hold
      PREVIEW HOLD — committed deliberately by scripts/notice.ts, NOT decided by the gate
      gate decision on this run: ALLOW — Similarity 0.4865 clears the threshold, but the arc is nearly as close to an ordinary contributor arc (margin -0.0595 < -0.019821238511858907) — not separable enough to justify holding a release.
      rationale and advisory wording: TEMPLATED (Bedrock unavailable); all values real
      assessed candidates: jia-tan, dennis-ens, jigar-kumar — judged on jia-tan
      EXPLAIN prefix-scoped: true
      Actor "jia-tan" has 13 recorded events over 848 days of tenure (first seen 2021-10-29).
      Trust escalated to a privileged role 188 days after first public activity.
      43% of this actor's commits touch build or CI machinery rather than library code — the layer that ships in release tarballs but is least reviewed.
      This actor now produces signed release artifacts (2 on record), so the artifact and its reviewer are the same party.
      2 account(s) with no code contributions (jigar-kumar, dennis-ens) argued for the maintainer handover and then stopped participating.

──────────────────────────────────────────────────────────────────────────────
AUDIT PATH REPORT
──────────────────────────────────────────────────────────────────────────────
  via:   direct
  calls: SQL SELECT, SQL SELECT, SQL SELECT, SQL SELECT, SQL SELECT

════════════════════════════════════════════════════════════════════════════════
  OFFLINE NOTICE PREVIEW — READ BEFORE READING ANYTHING BELOW
════════════════════════════════════════════════════════════════════════════════
  The transaction, the rows, the ids, the evidence trail and the format are REAL
  and were produced by the real code path against a real CockroachDB cluster.

  The rationale and advisory WORDING is TEMPLATED, because Bedrock Claude
  composes those two fields and no AWS credentials are configured here.

  THIS IS NOT A DETECTION. The gate did not decide to hold. This hold was
  committed DELIBERATELY, by this script, so that the notice a distro packager
  receives is inspectable without an AWS account. No number on this page is a
  measurement, and no line of it is evidence that anything was caught.
════════════════════════════════════════════════════════════════════════════════

Re-read this trail at any time:
  npm run explain -- --hold 1b261347-940a-4d41-ac1e-dfc5168b0a66

Remove the preview lane from the cluster:
  npm run notice -- --clean
```

The allow the gate actually made, from stderr — the same run, the same correlation id. This is the
record that says the gate looked and let the release through, and it is what makes the "not a
detection" claim above checkable rather than asserted:

```json
{"ts":"2026-08-11T22:20:24.399Z","level":"info","event":"decision.made","corrId":"7f698b61","packageId":"xz-utils-notice-preview","outcome":"allow","releaseVersion":"5.6.0","actorId":"jia-tan","assessedActors":["jia-tan","dennis-ens","jigar-kumar"],"similarity":0.4865,"margin":-0.059456,"holdAt":0.36947391406509944,"minMargin":-0.019821238511858907,"matchedPackageId":"syn-takeover-01","nearestBenignPackageId":"syn-benign-01","prefixScoped":true,"explanation":"Similarity 0.4865 clears the threshold, but the arc is nearly as close to an ordinary contributor arc (margin -0.0595 < -0.019821238511858907) — not separable enough to justify holding a release.","durMs":45}
```

### Transcript — `npm run explain -- --hold 1b261347-940a-4d41-ac1e-dfc5168b0a66`

Same rows, read back through the audit path a packager would use — a separate process, a separate
command, nothing carried over in memory. The `[TEMPLATED TEXT — NOT MODEL OUTPUT]` marker and the
`PROVENANCE` paragraph appear here because they are stored in the row, not because this section
added them.

```

> sleeper@0.1.0 explain
> tsx scripts/explain.ts --hold 1b261347-940a-4d41-ac1e-dfc5168b0a66

AUDIT PATH: direct SQL over the pg pool — NOT the Managed MCP Server
            reason: COCKROACH_MCP_API_KEY is not set — no CockroachDB Cloud service-account key to authenticate with

──────────────────────────────────────────────────────────────────────────────
HOLD 1b261347-940a-4d41-ac1e-dfc5168b0a66
──────────────────────────────────────────────────────────────────────────────
  package:   xz-utils-notice-preview
  version:   5.6.0
  committed: 2026-08-11T22:20:24.465Z
  similarity to nearest known takeover shape: 0.4865
  package trust status now: held

──────────────────────────────────────────────────────────────────────────────
WHY
──────────────────────────────────────────────────────────────────────────────
  [TEMPLATED TEXT — NOT MODEL OUTPUT] In a credentialed run Bedrock Claude composes this field
  (src/agent.ts, RATIONALE_SYSTEM). Bedrock is not configured here, so the sentences are
  fixed; the numbers, ids and observations inside them are the real ones this run produced.
  
  PROVENANCE — this hold is NOT a detection. It was committed deliberately by `npm run notice`
  (scripts/notice.ts) so the notice format is inspectable without AWS credentials. The gate's
  own decision on this run was ALLOW: "Similarity 0.4865 clears the threshold, but the arc is
  nearly as close to an ordinary contributor arc (margin -0.0595 < -0.019821238511858907) —
  not separable enough to justify holding a release."
  
  Release xz-utils-notice-preview 5.6.0 is paused pending review of the publishing account's
  behavioural arc.
  
  What the memory layer observed:
  - Actor "jia-tan" has 13 recorded events over 848 days of tenure (first seen 2021-10-29).
  - Trust escalated to a privileged role 188 days after first public activity.
  - 43% of this actor's commits touch build or CI machinery rather than library code — the
    layer that ships in release tarballs but is least reviewed.
  - This actor now produces signed release artifacts (2 on record), so the artifact and its
    reviewer are the same party.
  - 2 account(s) with no code contributions (jigar-kumar, dennis-ens) argued for the
    maintainer handover and then stopped participating.
  
  How that arc was retrieved: 25 events for this package were read back out of CockroachDB as
  of 2024-02-24. The account under assessment was not configured — 3 candidate(s) (jia-tan,
  dennis-ens, jigar-kumar) were ranked out of the package's own memory and assessed
  independently; this release is judged on "jia-tan". That account's history was rolled into a
  90-day arc, embedded, and searched against this package's own memory with an ANN query
  bounded by the leading vector-index column (EXPLAIN prefix-scoped: YES). The same arc vector
  was then matched, unscoped, against the takeover playbook.
  
  Nearest known takeover shape: syn-takeover-01 at cosine similarity 0.4865. Nearest
  ordinary-contributor shape: syn-benign-01 — a separation of -0.0595. Thresholds in force:
  holdAt 0.36947391406509944, minMargin -0.019821238511858907.
  
  What to check before clearing: the provenance of the release tarball against the tag it
  claims to build from; who reviewed the build-system changes in the release branch; whether
  the accounts that argued for the handover can be tied to any code contribution anywhere.
  
  This is a behavioural hold, not a confirmed vulnerability. Clear it with `npm run unhold --
  --hold <id> --by <who> --note "<why>"`, which appends the reversal rather than deleting this
  row.

──────────────────────────────────────────────────────────────────────────────
MATCHED PLAYBOOK ARC — syn-takeover-01 (takeover)
──────────────────────────────────────────────────────────────────────────────
  source: synthetic

  A contributor with no prior public history begins submitting small, competent patches to a long-neglected library. Within months they are the most responsive participant. Two other accounts, also with no history, appear on the mailing list and push the exhausted sole maintainer to hand over control, contributing no code themselves. The maintainer names the new contributor as successor. Commit access follows, then release-signing authority. The pressure accounts fall silent immediately afterward.

──────────────────────────────────────────────────────────────────────────────
DISTRO ADVISORIES QUEUED
──────────────────────────────────────────────────────────────────────────────
  [queued] b1092d89-ce98-4f66-ab20-86d909e9a86a
  [TEMPLATED TEXT — NOT MODEL OUTPUT] Bedrock Claude composes this field in a credentialed
  run; the wording below is a fixed template. NOT A DETECTION — committed deliberately by
  scripts/notice.ts.
  
  ADVISORY — xz-utils-notice-preview 5.6.0 HELD
  
  Downstream packagers (Debian, Fedora, Arch): do not promote xz-utils-notice-preview 5.6.0
  into a distribution channel while this hold stands.
  
  Reason: the publishing account's multi-year behavioural arc matches a known
  maintainer-takeover shape (syn-takeover-01, cosine similarity 0.4865, separation from the
  nearest ordinary-contributor arc -0.0595).
  
  Recommended action: keep the previous release in place, rebuild from the tagged source
  rather than the published tarball if you need the version, and ask the project to name a
  second reviewer for the release artifact.
  
  This hold is BEHAVIOURAL, not a confirmed vulnerability. No exploit has been demonstrated
  and no CVE is claimed. It may be withdrawn; a retraction advisory is queued to this same
  outbox if it is.


──────────────────────────────────────────────────────────────────────────────
AUDIT TRAIL
──────────────────────────────────────────────────────────────────────────────
  2026-08-11T22:20:24.465Z  agent  hold
      PREVIEW HOLD — committed deliberately by scripts/notice.ts, NOT decided by the gate
      gate decision on this run: ALLOW — Similarity 0.4865 clears the threshold, but the arc is nearly as close to an ordinary contributor arc (margin -0.0595 < -0.019821238511858907) — not separable enough to justify holding a release.
      rationale and advisory wording: TEMPLATED (Bedrock unavailable); all values real
      assessed candidates: jia-tan, dennis-ens, jigar-kumar — judged on jia-tan
      EXPLAIN prefix-scoped: true
      Actor "jia-tan" has 13 recorded events over 848 days of tenure (first seen 2021-10-29).
      Trust escalated to a privileged role 188 days after first public activity.
      43% of this actor's commits touch build or CI machinery rather than library code — the layer that ships in release tarballs but is least reviewed.
      This actor now produces signed release artifacts (2 on record), so the artifact and its reviewer are the same party.
      2 account(s) with no code contributions (jigar-kumar, dennis-ens) argued for the maintainer handover and then stopped participating.

──────────────────────────────────────────────────────────────────────────────
AUDIT PATH REPORT
──────────────────────────────────────────────────────────────────────────────
  via:   direct
  calls: SQL SELECT, SQL SELECT, SQL SELECT, SQL SELECT, SQL SELECT
```

### What this section does not claim

It does not claim a detection. The gate assessed release 5.6.0 and allowed it, and that ALLOW is
printed above, logged above, and quoted inside the stored hold reason. It does not claim a
measurement: the similarity and margin are real numbers out of a real vector search whose vectors
are a hashed bag-of-words, so they cost what a real query costs and mean nothing about accuracy —
the same separation §3 draws for latency. It does not claim the prose is model output; the two
fields that would be say so themselves, in the database.

What it does show is the deliverable: that a hold is four rows in one transaction, that the trail
behind it is legible to somebody who is not the agent, and that the format holds up when it is read
back cold. Run it with Bedrock credentials and `SLEEPER_OFFLINE` unset and the same trail comes out
with §2's real decision behind it and Claude's wording in those two fields.

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

### Latency only — this block contains NO accuracy figure

_Generated by `npm run bench -- --latency-only` on 2026-08-11._

**What was measured:** the SQL path, and nothing else. Local single-node `CockroachDB CCL v26.2.5` on `localhost:26257`, `SLEEPER_OFFLINE=1`, so the vectors are the deterministic hashed bag-of-words stand-in described in §4.

**Why that is legitimate here and nowhere else on this page.** The timed window is a CockroachDB ANN round trip plus pure arithmetic. Its cost is a property of the vector index, the row count and the 1024-dimension vector width — a 1024-dim stand-in vector descends exactly the same index as a Titan one. Which model produced the numbers changes what they *mean*, not what they *cost*.

**This is not an accuracy claim, and no accuracy figure can be derived from it.** The mode reads its probe vectors with a query that selects no `label` column, so the ground truth is not in the process; recall, hold recall, false-positive rate, precision and the lexical baseline are not computed, not printed, and not hidden. Accuracy still requires Bedrock, and `npm run bench` still refuses to produce it offline.

| stage (the timed window, exactly)            | p50    | p95    |
| -------------------------------------------- | ------ | ------ |
| playbook ANN query (CockroachDB) -> decide() | 0.8 ms | 1.3 ms |

n = 200 samples: 8 distinct held-out probe vectors x 25 repetitions, k=5. 1 untimed warm-up pass over every probe is excluded, so the numbers do not include TCP connect, the pg handshake or the first plan-cache miss.

**Corpus size: 16 arcs in `takeover_playbook`, of which the deciding query searches 8** (`held_out = false` and matching `embedding_model`, both index prefix columns). 8 rows is a *tiny* corpus. This p50 is a floor — what the round trip costs when the index has essentially nothing to descend — and it is **not** a scale result. Nothing here says what this query does at a million arcs, and this project has not measured that.

Host: node v22.22.0, Apple M1 Max. Single-node local cluster, loopback, no network between client and node — a CockroachDB Cloud deployment adds a real RTT that this number does not contain.

**Reproduce, exactly:**

```bash
export DATABASE_URL='postgresql://root@localhost:26257/sleeper?sslmode=disable'
export SLEEPER_OFFLINE=1
npm run schema && npm run seed
npm run bench -- --latency-only
```

**The plan, from the same node** — `EXPLAIN` over `PLAYBOOK_MATCH_SQL`, the literal string the hold decision runs (`src/memory.ts`). The `prefix spans` line is the point: the ANN scan descends only the `held_out = false` / matching-model subtree, so every one of the k candidates is eligible rather than filtered out after the fact. Index behaviour, like index latency, does not depend on which model produced the vector.

```
distribution: local

• top-k
│ estimated row count: 5
│ order: +distance
│ k: 5
│
└── • render
    │
    └── • lookup join
        │ table: takeover_playbook@takeover_playbook_pkey
        │ equality: (id) = (id)
        │ equality cols are key
        │
        └── • vector search
              table: takeover_playbook@takeover_playbook_embedding_idx
              target count: 5
              prefix spans: [/false/'offline-fnv1a-1024' - /false/'offline-fnv1a-1024']
```

**Still missing from this page: accuracy.** It is the one number that cannot be produced honestly without Bedrock, so it is absent rather than approximated. Run `npm run bench` with credentials and calibrated thresholds and it replaces this block wholesale.

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

207 tests: `168 passed | 39 skipped` with no database, `207 passed` against a reachable cluster.
A `DATABASE_URL` that is set but unreachable skips the 39 and prints why rather than failing —
a stale credential should not look like broken code.

The cluster-backed suite asserts, among other things:

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
| 2:45–3:00 | "The real world found this 34 days later, by luck." |
