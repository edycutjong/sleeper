# Security policy

## Reporting a vulnerability

Open a [private security advisory](https://github.com/edycutjong/sleeper/security/advisories/new).
Please do not open a public issue for anything exploitable.

Expect an acknowledgement within 72 hours.

## Scope, and what this project is not

Sleeper is a hackathon prototype for the CockroachDB × AWS Agentic Memory hackathon. It is not
running in production anywhere and holds no user data. Treat it as a reference implementation.

Two things are worth knowing before you rely on any part of it:

- **The privilege split is a real boundary, and it is the one security property this repo
  actually enforces.** `gate_svc` — the identity the running agent uses — holds no `DELETE` on any
  table, so the agent that writes a hold cannot erase the hold, the advisory, or the audit row.
  This is verified by execution, not asserted: see `DEMO.md` §1b, where seven negative controls
  each return `SQLSTATE 42501`.
- **The MCP audit path is read-only by client discipline, not by server enforcement.** CockroachDB
  Cloud's `tools/list` is not role-filtered, so write tools are advertised to identities that
  cannot execute them. This client only ever builds `SELECT`, `EXPLAIN` and `SHOW`. That is a
  convention in `src/mcp.ts`, and if you fork this, it is yours to keep. The enforced boundary is
  at the SQL layer.

## Secrets

No credentials are committed. `.env` is gitignored; `.env.example` carries placeholders only.
If you find a real secret in the history, report it privately using the link above.
