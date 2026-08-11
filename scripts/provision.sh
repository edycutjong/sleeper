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
#   3. TWO SQL identities, split along the line that actually exists in this codebase — SETUP
#      versus RUNTIME, not "ingest" versus "gate":
#        sleeper_admin — the operator's identity. DDL, one cluster setting, and the destructive
#                        setup paths: `npm run schema`, `npm run seed` (DELETEs the playbook) and
#                        `npm run replay` (starts with `resetPackage`, six DELETEs). Scoped to
#                        THIS database plus exactly one system privilege — it is not a cluster
#                        admin, cannot see another database and cannot create users.
#        gate_svc      — the running agent: the deployed webhook, the decision, the hold, and the
#                        unhold. SELECT everywhere, INSERT/UPDATE on the tables a decision writes,
#                        and NO DELETE and no DDL anywhere. It can stop a release and it can clear
#                        its own hold, but it cannot erase an event, a hold, an advisory or an
#                        audit row, and it cannot reset a package's memory.
#      There used to be an `ingest_svc` here holding INSERT/SELECT on `events` alone. It was
#      removed because it was decorative: the webhook entry point it supposedly owned is
#      `ingestHandler`, which calls `runReplay`, which rolls up an actor arc and can commit a
#      hold — five more tables. Verified by running it: an events-only identity fails the first
#      release-kind webhook with "does not have INSERT privilege on relation actor_arcs". A split
#      that cannot run the path it is named after is worse than no split, because it reads as a
#      security property while being a comment.
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
for user in sleeper_admin gate_svc; do
  info "SQL user '$user' — the generated password prints once; copy it now"
  run ccloud cluster user create "$CLUSTER" "$user" \
    || warn "'$user' already exists, or creation failed — continuing"
done

# ──────────────────────────────────────────────────────────────────────────────
# 4. The privilege split
# ──────────────────────────────────────────────────────────────────────────────
# `ccloud cluster user create` creates admins. Admin on both identities would make the "two
# identities with different privilege scopes" claim decorative, so the scopes are applied here in
# SQL and the admin role is dropped from both — including from sleeper_admin, whose name describes
# what it does for this project, not a role on the cluster.
#
# Two blobs, because they have different prerequisites and one is allowed to fail:
#
#   IDENTITY_SQL — connect/usage/create, plus the ONE system privilege `npm run schema` needs.
#                  Applies to an empty database, so the first run of this script does useful work.
#   TABLE_SQL    — the per-table split. Needs the tables, so it only lands after `npm run schema`.
#                  Re-run this script then; it is idempotent.
#
# The exact grants below are not guesswork: every path in the "Next" block at the bottom was run
# against a user holding precisely this set, and the DELETE/DDL statements gate_svc must never be
# able to issue were run too, to confirm they are refused.
step "4. Privilege scopes"

IDENTITY_SQL=$(cat <<SQL
-- sleeper_admin: the operator. Owns the schema, and is the only identity that may destroy data.
REVOKE admin FROM sleeper_admin;
GRANT CONNECT, CREATE ON DATABASE ${DATABASE} TO sleeper_admin;
GRANT ALL ON SCHEMA public TO sleeper_admin;

-- gate_svc: the running agent. Cannot create, drop or delete anything.
REVOKE admin FROM gate_svc;
GRANT CONNECT ON DATABASE ${DATABASE} TO gate_svc;
GRANT USAGE ON SCHEMA public TO gate_svc;

-- Last, because this is the one statement a hardened Cloud plan may refuse. sql/schema.sql opens
-- with \`SET CLUSTER SETTING feature.vector_index.enabled\`, which needs MODIFYCLUSTERSETTING —
-- a cluster-scoped privilege, so it cannot be granted per-database. It is the single system
-- privilege either identity holds, and gate_svc does not hold it. If your org refuses it, run
-- that one SET statement as your org admin: \`npm run schema\` already warns and continues.
GRANT SYSTEM MODIFYCLUSTERSETTING TO sleeper_admin;
SQL
)

TABLE_SQL=$(cat <<SQL
-- sleeper_admin created these tables on a fresh cluster and already owns them; the explicit grant
-- is for the case where somebody else ran the schema first.
GRANT ALL ON ALL TABLES IN SCHEMA public TO sleeper_admin;

-- gate_svc: reads everything, writes exactly what a decision writes.
--   INSERT events                     ingestEvent — the webhook's own event
--   INSERT/UPDATE actor_arcs          upsertActorArc is INSERT ... ON CONFLICT DO UPDATE
--   INSERT release_hold + UPDATE      commitHold writes it; commitUnhold updates it in place,
--                                     which is how the exit stays append-only rather than a DELETE
--   INSERT/UPDATE trust_state         both are INSERT ... ON CONFLICT DO UPDATE
--   INSERT advisory outbox, audit_log append-only by design
-- No DELETE anywhere, so a hold, its advisory and its audit row cannot be erased by the agent
-- that wrote them. No INSERT or UPDATE on takeover_playbook: the corpus the gate is judged
-- against is not writable by the thing being judged.
GRANT SELECT ON TABLE events, actor_arcs, takeover_playbook, release_hold, trust_state,
                      distro_advisory_outbox, audit_log TO gate_svc;
GRANT INSERT ON TABLE events, actor_arcs, release_hold, trust_state,
                      distro_advisory_outbox, audit_log TO gate_svc;
GRANT UPDATE ON TABLE actor_arcs, release_hold, trust_state TO gate_svc;

SHOW GRANTS ON DATABASE ${DATABASE};
SQL
)

# The connection URL carries the SQL password. Passing it as an argv element publishes it to every
# process on the box for the lifetime of the call (`ps`, /proc), so it travels in the environment
# instead: COCKROACH_URL is what `cockroach sql` reads natively. psql has no whole-URL variable,
# so the password alone is split out into PGPASSWORD and the URL that remains carries none.
url_password() {
  local rest="${1#*://}" pw
  case "$rest" in
    *@*) rest="${rest%%@*}" ;;   # userinfo
    *)   return 0 ;;
  esac
  case "$rest" in
    *:*) pw="${rest#*:}" ;;
    *)   return 0 ;;
  esac
  # Percent-DECODED. Inside a connection string the password is percent-encoded; PGPASSWORD wants
  # the literal one, so a generated password containing `@` (encoded `%40`) would otherwise be
  # sent verbatim and fail to authenticate. Every `%` in a URL userinfo starts an escape, so
  # rewriting them as `\x` and letting printf %b expand is a complete decode, `%25` included.
  printf '%b' "${pw//%/\\x}"
}

url_without_password() {
  local url="$1" scheme rest userinfo
  scheme="${url%%://*}"
  rest="${url#*://}"
  case "$rest" in
    *@*) userinfo="${rest%%@*}"; rest="${rest#*@}" ;;
    *)   printf '%s' "$url"; return 0 ;;
  esac
  printf '%s://%s@%s' "$scheme" "${userinfo%%:*}" "$rest"
}

apply_sql() {
  local url="$1" sql="$2"
  if command -v cockroach >/dev/null 2>&1; then
    printf '%s\n' "$sql" | COCKROACH_URL="$url" cockroach sql
  elif command -v psql >/dev/null 2>&1; then
    printf '%s\n' "$sql" | PGPASSWORD="$(url_password "$url")" psql "$(url_without_password "$url")"
  else
    return 2
  fi
}

show_sql() { printf '%s\n' "$1" | sed 's/^/      /'; }

if [ "$SKIP_GRANTS" = "1" ]; then
  warn "--skip-grants: both identities are still admins. Apply this before demoing:"
  show_sql "$IDENTITY_SQL"
  show_sql "$TABLE_SQL"
elif [ "$DRY_RUN" = "1" ]; then
  printf '  \033[2m$ COCKROACH_URL="$(ccloud cluster sql --connection-url --database %s %s)" cockroach sql\033[0m\n' "$DATABASE" "$CLUSTER"
  show_sql "$IDENTITY_SQL"
  show_sql "$TABLE_SQL"
else
  ADMIN_URL="$(ccloud cluster sql --connection-url --database "$DATABASE" "$CLUSTER" 2>/dev/null | tail -n1 || true)"
  if [ -z "$ADMIN_URL" ]; then
    warn "could not obtain a connection URL — run these statements yourself:"
    show_sql "$IDENTITY_SQL"
    show_sql "$TABLE_SQL"
  else
    if apply_sql "$ADMIN_URL" "$IDENTITY_SQL"; then
      ok "identity scopes applied"
    else
      warn "identity grants failed (no \`cockroach\` or \`psql\` on PATH?). Run these yourself:"
      show_sql "$IDENTITY_SQL"
    fi
    # Expected to fail on the very first run, before `npm run schema` has created the tables.
    # That is why the "Next" block tells you to run this script again afterwards.
    if apply_sql "$ADMIN_URL" "$TABLE_SQL"; then
      ok "table scopes applied"
    else
      warn "table grants did not apply — the tables must exist first. Run \`npm run schema\` with
      the sleeper_admin URL, then re-run this script. Or apply them yourself:"
      show_sql "$TABLE_SQL"
    fi
  fi
fi

# Housekeeping for anyone who provisioned before the ingest_svc/gate_svc split was replaced. The
# script never drops anything on your behalf — it only tells you what is now unused.
if [ "$DRY_RUN" != "1" ] && [ "$SKIP_GRANTS" != "1" ]; then
  info "if an \`ingest_svc\` exists from an earlier provision it is now unused; retire it with"
  info "  DROP USER ingest_svc;   (after checking no deployment still holds its password)"
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
  The URL above is the org admin's. Take the same URL twice and swap in each identity's own
  user and password — which command runs as which identity is not a style preference here, it is
  what the grants in step 4 allow. Every line below was checked by running it.

  cp .env.example .env
    DATABASE_URL         = the gate_svc URL — see "Running it" below
    COCKROACH_CLUSTER_ID = ${CLUSTER_ID:-<from the console URL>}
    COCKROACH_MCP_API_KEY= from ./scripts/provision.sh --mcp-key

$(bold "  Setup — sleeper_admin.") These create tables, set a cluster setting and DELETE rows.
  gate_svc is granted none of that and every one of them fails under it.
      export DATABASE_URL='<the sleeper_admin URL>'
      npm run schema        # DDL + SET CLUSTER SETTING feature.vector_index.enabled
      ./scripts/provision.sh   # re-run NOW: the table grants in step 4 need the tables
      npm run seed          # DELETEs and refills takeover_playbook
      npm run calibrate     # reads only; writes data/thresholds.json on this machine
      npm run replay        # opens with resetPackage — six DELETEs

$(bold "  Running it — gate_svc.") Holds a release, clears a hold, and cannot erase either.
      export DATABASE_URL='<the gate_svc URL>'
      npm run unhold -- --hold <uuid> --by <who> --note "<why>"
      npm run explain -- --hold <uuid>          # falls back to SQL without an MCP key
      the deployed webhook (\`ingestHandler\`)   # never resets; ingest + arc + decision + hold

  \`npm start\` is the exception, and deliberately so: its "Replay the xz timeline" button calls
  the same resetting replay as the CLI, so the local demo server needs the sleeper_admin URL.
  The deployed webhook — the path that runs unattended — is the one that runs as gate_svc.

      npm run mcp:audit     # neither SQL identity: the read-only MCP service account
EOF
