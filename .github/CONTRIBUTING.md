# Contributing

## Getting a working environment

You do not need an AWS account or a CockroachDB Cloud subscription to work on this.

```bash
npm install

# A local node is enough — vector indexes included.
cockroach start-single-node --insecure --listen-addr=localhost:26257 --store=/tmp/sleeper-crdb
cockroach sql --insecure -e 'CREATE DATABASE sleeper'

export DATABASE_URL='postgresql://root@localhost:26257/sleeper?sslmode=disable'
export SLEEPER_OFFLINE=1   # deterministic hashed stand-in instead of Bedrock

npm run schema && npm run seed
npm test          # 207 passed
```

Without `DATABASE_URL` you get `168 passed | 39 skipped` — that is correct, not a failure. If
`DATABASE_URL` is set but nothing answers, the 39 skip and the runner prints why.

## Before you open a PR

```bash
npm run typecheck   # must be clean
npm test            # must be green
```

CI runs both, plus the full suite against a real CockroachDB node.

## What this codebase cares about

**Say what is true, including when it is inconvenient.** The README carries the line "Nothing in
this README claims a capability the code does not have," and it is meant to be falsifiable. If your
change makes a documented claim untrue, fix the document in the same PR. A PR that quietly widens a
claim is harder to review than one that admits a limitation.

**Never fabricate a measurement.** `npm run bench` refuses to compute accuracy in offline mode, and
refuses thresholds fitted by the offline stand-in. Those refusals are load-bearing: a recall figure
computed on hashed bag-of-words vectors would be a property of the hash. If you need a number that
cannot be measured honestly, the correct output is no number and a sentence explaining why.

**Comments explain why, not what.** The code is read by people deciding whether to trust a system
that blocks releases. A comment recording a rejected alternative, or an accepted cost, is worth
more than one restating the line beneath it.

**Structural signals stay evidence, not votes.** `src/signals.ts` computes tenure, privilege-
escalation speed and build-system concentration, and they are deliberately excluded from the
decision. If you want them to decide, that is a design argument to make in an issue first — it
changes what the system is.

**Tests that need a cluster go in the cluster-backed suite** and must skip cleanly without one.
Do not weaken an assertion to make a suite pass.

## Reporting bugs

Include what you ran, what you expected, what happened, and whether `DATABASE_URL` was set and
reachable. For anything security-relevant, see [SECURITY.md](SECURITY.md) instead.
