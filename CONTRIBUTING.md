# Contributing

## Setup

```bash
npm install
npm test          # 588 tests; cluster-backed ones skip and say why
```

The suite runs with no database and no AWS account. On a clean clone you should see
`522 passed | 66 skipped (588)`. The 66 skip because no cluster is reachable — that is expected,
not a failure. Point `DATABASE_URL` at a cluster and they run:

```bash
cockroach start-single-node --insecure --listen-addr=localhost:26257 --store=/tmp/sleeper-crdb
cockroach sql --insecure -e 'CREATE DATABASE sleeper'
export DATABASE_URL='postgresql://root@localhost:26257/sleeper?sslmode=disable'
npm run schema && npm test
```

Full setup, including CockroachDB Cloud and Bedrock, is in [DEMO.md](DEMO.md) §1.

## Before opening a PR

```bash
npm run typecheck
npm test
npm run counts     # regenerates tests/counts.json
```

CI runs all three. Coverage thresholds are **100%** for lines, branches, functions and statements
(`vitest.config.ts`), so an untested branch fails the build on the commit that introduced it.

## Two conventions that are not negotiable

**Numbers in prose must be generated, not typed.** The README states its own test counts, and
`tests/claims.test.ts` asserts them against `tests/counts.json`, which `npm run counts` writes from
vitest. This exists because the same class of error recurred four times: a number was correct when
written and silently wrong three features later. If you add a claim with a number in it, add the
assertion too.

**Do not raise coverage by weakening a test.** 100% is already met; `src/decide.ts` once sat at
100% lines while shipping a gate whose abstain path never fired. Coverage says no line is
unexamined. It does not say the behaviour is right.

## Commits

Describe what changed and why it was wrong before. The history is part of what this repo is for.
