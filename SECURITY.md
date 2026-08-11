# Security Policy

## Reporting a vulnerability

Open a [private security advisory](../../security/advisories/new). Please do not open a public
issue for a vulnerability.

## Threat model

Sleeper decides whether to block a software release, and it decides from memory built out of
attacker-authored text. That shapes what counts as a vulnerability here.

**In scope, and taken seriously:**

- **Prompt injection through event content.** Commit messages, mailing-list posts and release
  notes are written by the very actor being assessed. They are fenced before they reach the arc
  prompt, the system prompt states that fenced text is data and never instruction, and
  instruction-shaped phrasing is neutralised (`src/agent.ts`). The fencing and the fact that the
  model's output is *embedded, not executed* are the real mitigations; the denylist is a third
  layer and is defeatable on its own. A bypass that changes a decision is a genuine finding.
- **Poisoning the memory.** The ingest path has no authentication of its own — it is expected to
  sit behind an authenticated gateway. Duplicate deliveries cannot double-write (`events` carries
  a unique `event_key`), but an attacker who can post arbitrary events to the endpoint can shape
  what the agent later retrieves. Treat the endpoint as privileged.
- **SQL construction on the MCP path.** The Managed MCP Server accepts one statement per call with
  no bind-parameter channel, so those statements are built as text. Every value goes through
  `sqlLiteral`/`assertUuid`, statement splitting runs against a redacted copy so a semicolon inside
  a literal is not a boundary, and every SELECT must carry an explicit `LIMIT` — otherwise the
  server's implicit `LIMIT 25` would silently present a truncated evidence trail as complete. A way
  around any of those is a genuine finding.
- **Anything that makes a hold or an unhold half-land.** The four-write HOLD is one transaction and
  the paper trail is append-only by design.

**Out of scope:**

- The demo server (`npm start`). It binds loopback by default and is a demonstration surface, not a
  production service. Widening `SLEEPER_BIND_HOST` is a deliberate act.
- Denial of service through volume against a local node.
- Findings that require an attacker who already holds the database credential.

## Credentials

No credential is ever committed. `.env` is gitignored; `.env.example` carries placeholders only.
`scripts/provision.sh` prints generated passwords and API keys once, to the terminal, and never
writes them to disk.

If you believe a credential has been committed to this repository, report it privately as above —
do not open an issue naming it.
