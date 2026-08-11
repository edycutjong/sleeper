#!/usr/bin/env bash
#
# Provision everything Sleeper needs on CockroachDB Cloud, with the `ccloud` CLI.
#
#   ./scripts/provision.sh                 # cluster + database + the two service identities
#   ./scripts/provision.sh --mcp-key       # ... and the service account + API key for MCP
#   ./scripts/provision.sh --dry-run       # print every command without running any of it
#
# What it creates, and why each piece exists:
#
#   1. a Basic (free-tier) cluster                     — the memory engine
#   2. a database                                      — everything in sql/schema.sql lands here
#   3. TWO SQL identities with DIFFERENT privileges:
#        ingest_svc — INSERT/SELECT on `events` only. The webhook path can add to memory and can
#                     do nothing else: it cannot read the playbook, cannot hold a release, cannot
#                     touch the audit log. A compromised ingest endpoint cannot clear a hold.
#        gate_svc   — SELECT everywhere, plus INSERT/UPDATE on exactly the tables the atomic HOLD
#                     writes. It is the only identity that can block a release, and it is granted
#                     no DELETE anywhere, so a hold and its paper trail are append-only to it.
#   4. optionally, a service account + API key for the Managed MCP Server — a THIRD identity,
#      cluster-scoped and read-only, which is what `npm run explain` and `npm run mcp:audit`
#      authenticate as.
#
# Idempotent: an existing cluster, database, user or service account is reused, never recreated.
# Safe to re-run. Nothing secret is written to disk — passwords and API keys are printed once, by
# ccloud, for you to paste into .env, which is gitignored.
#
# Every ccloud invocation below was checked against `ccloud --help` for the installed CLI
# (v0.8.x). Run with --dry-run to see the exact commands before anything touches your org.
#
set -euo pipefail

CLUSTER="${SLEEPER_CLUSTER:-sleeper-cluster}"
DATABASE="${SLEEPER_DATABASE:-sleeper}"
SA_NAME="${SLEEPER_MCP_SA:-sleeper-mcp}"
# Least-privileged cluster-scoped role in CockroachDB Cloud's RBAC. The MCP audit path only ever
# reads; if your org names its roles differently, override this rather than reaching for admin.
MCP_ROLE="${SLEEPER_MCP_ROLE:-CLUSTER_DEVELOPER}"
CLOUD="GCP"
REGION=""
MAKE_MCP_KEY=0
SKIP_GRANTS=0
DRY_RUN=0

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
info()  { printf '  %s\n' "$*"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$*" >&2; }
die()   { printf '\033[31mERROR\033[0m %s\n' "$*" >&2; exit 1; }
step()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

usage() {
  # The header comment above IS the usage text — printed from the file so the two cannot drift.
  awk 'NR<3 {next} /^#/ {sub(/^# ?/, ""); print; next} {exit}' "$0"
  cat <<'EOF'
Options:
  --cluster NAME     cluster name              (default: sleeper-cluster, or $SLEEPER_CLUSTER)
  --database NAME    database name             (default: sleeper, or $SLEEPER_DATABASE)
  --cloud GCP|AWS    cloud provider            (default: GCP)
  --region REGION    region, e.g. us-east1     (default: let CockroachDB Cloud choose)
  --mcp-key          also create the MCP service account + API key
  --skip-grants      create the users but do not apply the privilege split
  --dry-run          print every command instead of running it
  -h, --help         this text
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --cluster)     CLUSTER="${2:?--cluster needs a name}"; shift 2 ;;
    --database)    DATABASE="${2:?--database needs a name}"; shift 2 ;;
    --cloud)       CLOUD="${2:?--cloud needs GCP, AWS or AZURE}"; shift 2 ;;
    --region)      REGION="${2:?--region needs a region}"; shift 2 ;;
    --mcp-key)     MAKE_MCP_KEY=1; shift ;;
    --skip-grants) SKIP_GRANTS=1; shift ;;
    --dry-run)     DRY_RUN=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *)             die "Unknown option: $1  (try --help)" ;;
  esac
done

# Every mutating command goes through here, so --dry-run is honest rather than partial.
run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '  \033[2m$ %s\033[0m\n' "$*"
    return 0
  fi
  "$@"
}

# Pull one field out of a `ccloud ... -o json` payload. Node is already a prerequisite of this
# repo, so this needs no extra tooling; `jq` is used instead when it happens to be installed.
json_field() {
  local match_key="$1" match_value="$2" want="$3"
  if command -v jq >/dev/null 2>&1; then
    jq -r --arg k "$match_key" --arg v "$match_value" --arg w "$want" \
      '(if type=="object" then (.clusters // .service_accounts // .serviceAccounts // to_entries[0].value) else . end)
       | map(select(.[$k] == $v)) | .[0][$w] // empty' 2>/dev/null
  else
    node -e '
      const [k, v, w] = process.argv.slice(1)
      let raw = ""
      process.stdin.on("data", (c) => (raw += c)).on("end", () => {
        try {
          let doc = JSON.parse(raw)
          if (!Array.isArray(doc) && doc && typeof doc === "object") {
            doc = doc.clusters ?? doc.service_accounts ?? doc.serviceAccounts ??
                  Object.values(doc).find(Array.isArray) ?? []
          }
          const hit = doc.find((row) => row && row[k] === v)
          if (hit && hit[w] != null) process.stdout.write(String(hit[w]))
        } catch { /* not JSON — caller falls back to the table parser */ }
      })
    ' "$match_key" "$match_value" "$want" 2>/dev/null
  fi
}

# ──────────────────────────────────────────────────────────────────────────────
# 0. Preflight
# ──────────────────────────────────────────────────────────────────────────────
step "0. Preflight"

command -v ccloud >/dev/null 2>&1 || die "ccloud is not on PATH.
  macOS:  brew install cockroachdb/tap/ccloud
  other:  https://www.cockroachlabs.com/docs/cockroachcloud/ccloud-get-started"
ok "$(ccloud version 2>/dev/null | head -n1 || echo 'ccloud (version unknown)')"

if ! ccloud auth whoami >/dev/null 2>&1; then
  warn "not logged in — running \`ccloud auth login\` (a browser will open)"
  run ccloud auth login \
    || die "ccloud auth login failed. On a headless host: ccloud auth login --no-redirect"
fi
if [ "$DRY_RUN" != "1" ]; then
  ok "authenticated: $(ccloud auth whoami 2>/dev/null | tr '\n' ' ')"
fi

# ──────────────────────────────────────────────────────────────────────────────
# 1. Cluster
# ──────────────────────────────────────────────────────────────────────────────
step "1. Cluster '$CLUSTER'"

cluster_json() { ccloud cluster list -o json 2>/dev/null || true; }

CLUSTER_ID="$(cluster_json | json_field name "$CLUSTER" id || true)"

if [ -n "$CLUSTER_ID" ]; then
  ok "already exists — reusing it (this script never recreates or deletes a cluster)"
else
  info "creating a BASIC (free-tier) cluster on ${CLOUD}…"
  # BASIC with no --request-unit-limit / --storage-gib-limit stays inside the free allowance,
  # and a Basic cluster is enough for the vector indexes in sql/schema.sql.
  if [ -n "$REGION" ]; then
    run ccloud cluster create BASIC "$CLUSTER" "$REGION" --cloud "$CLOUD" --wait
  else
    run ccloud cluster create BASIC "$CLUSTER" --cloud "$CLOUD" --wait
  fi
  CLUSTER_ID="$(cluster_json | json_field name "$CLUSTER" id || true)"
  [ "$DRY_RUN" = "1" ] || ok "created"
fi

if [ -n "$CLUSTER_ID" ]; then
  # This is the value that pins an MCP session to one cluster via the `mcp-cluster-id` header.
  ok "cluster id: $CLUSTER_ID   → COCKROACH_CLUSTER_ID"
elif [ "$DRY_RUN" != "1" ]; then
  warn "could not read the cluster id; it is the highlighted part of the console URL:
      https://cockroachlabs.cloud/cluster/{THIS_PART}/overview"
fi

# ──────────────────────────────────────────────────────────────────────────────
# 2. Database
# ──────────────────────────────────────────────────────────────────────────────
step "2. Database '$DATABASE'"

if ccloud cluster database list "$CLUSTER" 2>/dev/null | grep -qx -- "$DATABASE"; then
  ok "already exists — reusing it"
else
  run ccloud cluster database create "$CLUSTER" "$DATABASE" || warn "database create failed (it may already exist)"
  [ "$DRY_RUN" = "1" ] || ok "created"
fi

# ──────────────────────────────────────────────────────────────────────────────
# 3. The two service identities
# ──────────────────────────────────────────────────────────────────────────────
step "3. Service identities"

# `ccloud cluster user create` prints a generated password ONCE. It is deliberately not captured,
# echoed to a file, or stored anywhere — copy it out of the terminal into .env.
for user in ingest_svc gate_svc; do
  info "SQL user '$user' — the generated password prints once; copy it now"
  run ccloud cluster user create "$CLUSTER" "$user" \
    || warn "'$user' already exists, or creation failed — continuing"
done

# ──────────────────────────────────────────────────────────────────────────────
# 4. The privilege split
# ──────────────────────────────────────────────────────────────────────────────
# `ccloud cluster user create` creates admins. Admin on both identities would make the "two
# service identities with different privilege scopes" claim decorative, so the scopes are applied
# here in SQL and the admin role is dropped from both. Run this AFTER `npm run schema`, since it
# grants on tables.
step "4. Privilege scopes"

GRANTS_SQL=$(cat <<SQL
-- ingest_svc: the webhook path. Adds to memory, and can do nothing else.
REVOKE admin FROM ingest_svc;
GRANT CONNECT ON DATABASE ${DATABASE} TO ingest_svc;
GRANT USAGE ON SCHEMA public TO ingest_svc;
GRANT INSERT, SELECT ON TABLE events TO ingest_svc;

-- gate_svc: the decision path. Reads everything, writes only what a HOLD writes, deletes nothing.
REVOKE admin FROM gate_svc;
GRANT CONNECT ON DATABASE ${DATABASE} TO gate_svc;
GRANT USAGE ON SCHEMA public TO gate_svc;
GRANT SELECT ON TABLE events, actor_arcs, takeover_playbook, release_hold, trust_state,
                      distro_advisory_outbox, audit_log TO gate_svc;
GRANT INSERT ON TABLE actor_arcs, release_hold, trust_state,
                      distro_advisory_outbox, audit_log TO gate_svc;
GRANT UPDATE ON TABLE trust_state, distro_advisory_outbox TO gate_svc;

SHOW GRANTS ON DATABASE ${DATABASE};
SQL
)

apply_grants() {
  local url="$1"
  if command -v cockroach >/dev/null 2>&1; then
    printf '%s\n' "$GRANTS_SQL" | cockroach sql --url "$url"
  elif command -v psql >/dev/null 2>&1; then
    printf '%s\n' "$GRANTS_SQL" | psql "$url"
  else
    return 2
  fi
}

if [ "$SKIP_GRANTS" = "1" ]; then
  warn "--skip-grants: both identities are still admins. Apply this before demoing:"
  printf '%s\n' "$GRANTS_SQL" | sed 's/^/      /'
elif [ "$DRY_RUN" = "1" ]; then
  printf '  \033[2m$ ccloud cluster sql --connection-url --database %s %s | cockroach sql --url -\033[0m\n' "$DATABASE" "$CLUSTER"
  printf '%s\n' "$GRANTS_SQL" | sed 's/^/      /'
else
  ADMIN_URL="$(ccloud cluster sql --connection-url --database "$DATABASE" "$CLUSTER" 2>/dev/null | tail -n1 || true)"
  if [ -z "$ADMIN_URL" ]; then
    warn "could not obtain a connection URL — run these statements yourself:"
    printf '%s\n' "$GRANTS_SQL" | sed 's/^/      /'
  elif apply_grants "$ADMIN_URL"; then
    ok "privilege scopes applied"
  else
    warn "neither \`cockroach\` nor \`psql\` is on PATH (or the statements failed — tables must
      exist first: run \`npm run schema\`). Run these yourself:"
    printf '%s\n' "$GRANTS_SQL" | sed 's/^/      /'
  fi
fi

# ──────────────────────────────────────────────────────────────────────────────
# 5. The MCP identity (optional)
# ──────────────────────────────────────────────────────────────────────────────
if [ "$MAKE_MCP_KEY" = "1" ]; then
  step "5. Managed MCP Server identity"

  sa_json() { ccloud service-account list -o json 2>/dev/null || true; }
  SA_ID="$(sa_json | json_field name "$SA_NAME" id || true)"

  if [ -n "$SA_ID" ]; then
    ok "service account '$SA_NAME' already exists — reusing it ($SA_ID)"
  else
    run ccloud service-account create "$SA_NAME" \
      --description "Sleeper audit path — read-only access via the Managed MCP Server" \
      || warn "service-account create failed"
    SA_ID="$(sa_json | json_field name "$SA_NAME" id || true)"
    [ "$DRY_RUN" = "1" ] || ok "created${SA_ID:+ ($SA_ID)}"
  fi

  # Cluster-scoped, read-only. The MCP write tools (create_table / insert_rows) are only exposed
  # when write access is granted at auth — this identity must never have it, because the audit
  # path is the one surface a distro packager touches and it has no business writing anything.
  if [ -n "${SA_ID:-}" ] && [ -n "${CLUSTER_ID:-}" ]; then
    run ccloud role add "$SA_ID" "$MCP_ROLE" CLUSTER "$CLUSTER_ID" \
      || warn "could not grant $MCP_ROLE on CLUSTER $CLUSTER_ID — assign a READ-ONLY cluster role
      to '$SA_NAME' in the console (Access Management → Service Accounts)"
  else
    warn "skipping the role grant: service account id or cluster id unknown"
  fi

  warn "the API key below is displayed ONCE — paste it into .env as COCKROACH_MCP_API_KEY"
  if [ -n "${SA_ID:-}" ]; then
    run ccloud service-account api-key create "$SA_ID" "${SA_NAME}-key" \
      || warn "api-key create failed — create one in the console on service account '$SA_NAME'"
  else
    run ccloud service-account api-key create '<service-account-id>' "${SA_NAME}-key"
  fi

  cat <<EOF

  Then, in .env:
      COCKROACH_MCP_API_KEY=<the key printed above>
      COCKROACH_CLUSTER_ID=${CLUSTER_ID:-<cluster id from the console URL>}

  And verify the whole MCP path end to end:
      npm run mcp:audit
EOF
fi

# ──────────────────────────────────────────────────────────────────────────────
# 6. Connection string
# ──────────────────────────────────────────────────────────────────────────────
step "6. Connection string"

if [ "$DRY_RUN" = "1" ]; then
  printf '  \033[2m$ ccloud cluster sql --connection-url --database %s %s\033[0m\n' "$DATABASE" "$CLUSTER"
else
  ccloud cluster sql --connection-url --database "$DATABASE" "$CLUSTER" \
    || warn "could not print the connection URL"
fi

cat <<EOF

$(bold "Next")
  cp .env.example .env
    DATABASE_URL         = the connection URL above (use the gate_svc credentials for the agent)
    COCKROACH_CLUSTER_ID = ${CLUSTER_ID:-<from the console URL>}
    COCKROACH_MCP_API_KEY= from ./scripts/provision.sh --mcp-key

  npm run schema && npm run seed && npm run calibrate
  ./scripts/provision.sh                 # re-run once tables exist, to apply the grants
  npm run replay
  npm run mcp:audit                      # proves the Managed MCP Server path end to end
EOF
