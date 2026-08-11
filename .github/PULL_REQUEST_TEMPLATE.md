## What this changes

<!-- One or two sentences. If it changes a decision the gate makes, say so first. -->

## Why

<!-- The alternative you rejected is more useful here than a restatement of the diff. -->

## Checks

- [ ] `npm run typecheck` clean
- [ ] `npm test` green (state whether `DATABASE_URL` was set and reachable)
- [ ] No documented claim became untrue — if one did, it is corrected in this PR
- [ ] No measurement is reported that was not actually measured

## If this touches the decision path

- [ ] Structural signals are still evidence, not votes
- [ ] Thresholds are still fitted on the playbook split only, never on the evaluation set
- [ ] Any new retrieval is bounded and, where it matters, `EXPLAIN`-proven
