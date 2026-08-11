/**
 * `npm run mcp:audit` — drive the CockroachDB Cloud Managed MCP Server end to end.
 *
 * One command a judge can run to watch the MCP integration work, in the order it works:
 *
 *   1. auth + `tools/list`   — what this service account is actually allowed to see, and a hard
 *                              check that none of it can write (the README's read-only claim)
 *   2. `show_statement`      — SHOW introspection through the server
 *   3. `get_table_schema`    — the evidence tables as the CLUSTER describes them
 *   4. `explain_query`       — the `prefix spans` proof, produced server-side
 *   5. `select_query`        — the hold, and then the whole evidence trail via `holdEvidence`
 *   6. guardrails            — the documented per-call limits, rejected locally before dialling
 *
 * It deliberately does NOT fall back. `npm run explain` falls back to direct SQL because a distro
 * packager needs the evidence more than they need a particular transport; this script exists to
 * prove the MCP path specifically, so a missing key or an unreachable server is a failure and
 * exits non-zero.
 *
 * Requires COCKROACH_MCP_API_KEY (and, strongly recommended, COCKROACH_CLUSTER_ID) in .env —
 * both created by `scripts/provision.sh`.
 */
import { config } from '../src/config.js'
import { closePool } from '../src/db.js'
import { EVIDENCE_SQL, holdEvidence, scopedNeighbourExplainSql } from '../src/memory.js'
import {
  CockroachMcpClient,
  MCP_MAX_STATEMENT_CHARS,
  MCP_TOOLS,
  McpLimitError,
  assertReadOnlyTools,
  assertSingleStatement,
  hasExplicitLimit,
  planProbeVector,
  resolveMcpMode,
  sqlLiteral,
  writeCapableTools,
} from '../src/mcp.js'

/** Deterministic, dense, right-width — see `planProbeVector`. Costs no Bedrock call. */
const PROBE = planProbeVector(config.aws.embeddingDimensions)

function rule(title: string): void {
  console.log(`\n${'─'.repeat(78)}\n${title}\n${'─'.repeat(78)}`)
}

function indent(text: string): string {
  return text.replace(/^/gm, '  ')
}

/** Local checks — these never leave the process, and that is the point of them. */
function guardrails(): void {
  rule('6. GUARDRAILS — the documented per-call limits, enforced before anything is dialled')

  const twoStatements = 'SELECT 1 LIMIT 1; SELECT 2 LIMIT 1'
  try {
    assertSingleStatement(twoStatements)
    console.log('  ✗ two statements were NOT rejected — the limit check is broken')
    process.exitCode = 1
  } catch (err) {
    if (!(err instanceof McpLimitError)) throw err
    console.log(`  ✓ one statement per call: ${err.message}`)
  }

  const semicolonInLiteral = `SELECT * FROM audit_log WHERE detail = 'a;b' LIMIT 1`
  console.log(`  ✓ a semicolon inside a string literal is not a statement boundary:`)
  console.log(`      ${assertSingleStatement(semicolonInLiteral)}`)

  // The mirror image of the line above, and the more dangerous one: text inside a literal must not
  // be read as a LIMIT either, or the server applies its implicit cap and a truncated evidence
  // trail arrives looking complete.
  const limitInLiteral = `SELECT detail FROM audit_log WHERE detail = 'limit 25 exceeded'`
  if (hasExplicitLimit(limitInLiteral)) {
    console.log('  ✗ "limit 25" inside a string literal was counted as a LIMIT — the guard is bypassable')
    process.exitCode = 1
  } else {
    console.log(`  ✓ "limit 25" inside a string literal is not a LIMIT — that SELECT is still refused`)
  }

  const plan = scopedNeighbourExplainSql(config.packageId, PROBE, 20)
  console.log(
    `  ✓ ${config.aws.embeddingDimensions}-dim EXPLAIN statement is ${plan.length} chars ` +
      `(limit ${MCP_MAX_STATEMENT_CHARS}; at full float precision it would be ~20,900)`,
  )

  try {
    assertSingleStatement(scopedNeighbourExplainSql(config.packageId, PROBE, 20, 17))
    console.log('  ✗ an oversized statement was NOT rejected')
    process.exitCode = 1
  } catch (err) {
    if (!(err instanceof McpLimitError)) throw err
    console.log(`  ✓ oversized statement rejected: ${err.message.split('.')[0]}.`)
  }
}

async function main(): Promise<void> {
  const mode = resolveMcpMode()
  if (mode.via === 'direct') {
    console.error('MCP audit cannot run — the Managed MCP Server is not configured.')
    console.error(`  reason: ${mode.reason}`)
    console.error('')
    console.error('  Fix:  ./scripts/provision.sh --mcp-key      # creates the service account + key')
    console.error('        then set COCKROACH_MCP_API_KEY and COCKROACH_CLUSTER_ID in .env')
    process.exitCode = 1
    return
  }

  rule('1. CONNECT — CockroachDB Cloud Managed MCP Server')
  console.log(`  endpoint:      ${mode.endpoint}`)
  console.log(`  auth:          Authorization: Bearer <COCKROACH_MCP_API_KEY>`)
  console.log(
    `  cluster pin:   ${mode.clusterPinned ? `mcp-cluster-id: ${config.mcp.clusterId()}` : 'NONE — set COCKROACH_CLUSTER_ID to pin the session to one cluster'}`,
  )

  const client = new CockroachMcpClient(
    { endpoint: mode.endpoint, apiKey: config.mcp.apiKey()!, clusterId: config.mcp.clusterId() },
    mode.reason,
  )

  try {
    const tools = await client.connect()
    console.log(`\n  tools/list → ${tools.length} tools advertised:`)
    for (const t of tools) console.log(`    ${t.name.padEnd(22)} ${t.description ?? ''}`)

    const need = Object.values(MCP_TOOLS)
    const missing = need.filter((n) => !client.availableTools().includes(n))
    console.log(`\n  tools this project drives: ${need.join(', ')}`)
    if (missing.length) {
      console.log(`  ⚠️  not advertised by this session: ${missing.join(', ')}`)
    } else {
      console.log('  ✓ all present')
    }

    // The README tells a distro packager the audit path is read-only at the protocol layer. That
    // is a property of the service account's cluster role, not of the transport, and nothing used
    // to verify it — so it is checked here against what the server actually advertises.
    //
    // A write tool aborts the audit rather than warning. Everything printed after this point is
    // described as read-only evidence; printing it under a session that can write would be
    // reassuring and wrong.
    try {
      assertReadOnlyTools(client.availableTools())
      console.log('  ✓ read-only: no write-capable tool name is advertised to this session')
    } catch (err) {
      console.error(`\n  ✗ READ-ONLY CLAIM BROKEN — ${err instanceof Error ? err.message : String(err)}`)
      console.error(`\n  Advertised: ${client.availableTools().join(', ')}`)
      console.error(`  Write-capable: ${writeCapableTools(client.availableTools()).join(', ')}`)
      console.error('  Aborting: the rest of this audit would present itself as read-only evidence.')
      process.exitCode = 1
      return
    }

    rule(`2. ${MCP_TOOLS.show} — SHOW introspection through the server`)
    console.log(indent(await client.show('SHOW DATABASE')))

    rule(`3. ${MCP_TOOLS.tableSchema} — the evidence tables, as the cluster describes them`)
    // The session is pinned to a CLUSTER, not a database, so the database is named explicitly —
    // derived from DATABASE_URL so it cannot drift from the cluster the rest of the demo uses.
    // If the server declares the argument required, omitting it fails the call outright.
    const database = config.databaseName() ?? undefined
    console.log(`  database argument: ${database ?? 'NONE — DATABASE_URL is not set, sending table only'}`)
    for (const table of ['events', 'release_hold', 'audit_log']) {
      console.log(`\n  ── ${table}`)
      console.log(indent(await client.tableSchema(table, database)))
    }

    rule(`4. ${MCP_TOOLS.explain} — the prefix-scoped ANN plan, produced server-side`)
    // The plan does not depend on the vector's contents, only on its width and on the query
    // shape, so a deterministic local probe vector is used here rather than a Bedrock call.
    const planSql = scopedNeighbourExplainSql(config.packageId, PROBE, 20)
    const plan = await client.explain(planSql)
    console.log(indent(plan))
    console.log(
      `\n  prefix spans present: ${/prefix spans:/i.test(plan) ? 'YES' : 'NO'}` +
        `   vector search: ${/vector search/i.test(plan) ? 'YES' : 'NO'}`,
    )

    rule(`5. ${MCP_TOOLS.select} — the hold, then the whole evidence trail`)
    // PACKAGE_ID comes out of the environment, so it is quoted with sqlLiteral like every other
    // interpolated value in this repo (see EVIDENCE_SQL in src/memory.ts). There is no bind
    // channel over MCP; the rule only holds if the file demonstrating it follows it too.
    const latest = await client.selectRaw<{ id: string }>(
      `SELECT id FROM release_hold WHERE package_id = ${sqlLiteral(config.packageId)} ` +
        `ORDER BY created_at DESC LIMIT 1`,
    )
    // The result encoding is not part of the published contract — printing which shape the live
    // server actually used is the difference between a diagnosable first run and a guess.
    console.log(`  result encoding: ${latest.format} (${latest.rows.length} row(s))`)
    const holdId = latest.rows[0]?.id
    if (!holdId) {
      console.log(`  No release_hold rows for ${config.packageId} yet — run \`npm run replay\` first.`)
      console.log(`  (Statement sent: ${EVIDENCE_SQL.hold('00000000-0000-0000-0000-000000000000')})`)
    } else {
      console.log(`  latest hold: ${holdId}`)
      const evidence = await holdEvidence(holdId, client)
      console.log(`  version:     ${evidence?.hold.releaseVersion}`)
      console.log(`  similarity:  ${evidence?.hold.similarity.toFixed(4)}`)
      console.log(`  trust:       ${evidence?.trustStatus}`)
      console.log(`  advisories:  ${evidence?.advisories.length}`)
      console.log(`  audit rows:  ${evidence?.auditTrail.length}`)
      console.log(
        '\n  Every one of those rows came back through select_query — five separate one-statement,\n' +
          '  read-only tool calls. The HOLD that wrote them is still a direct-SQL transaction, because\n' +
          '  one statement per call cannot express a four-write COMMIT.',
      )
    }

    guardrails()

    rule('MCP TOOL CALLS MADE, IN ORDER')
    client.calls.forEach((c, i) => console.log(`  ${String(i + 1).padStart(2)}. ${c}`))
    const distinct = new Set(client.calls.filter((c) => c !== 'tools/list'))
    console.log(`\n  distinct MCP tools exercised: ${distinct.size} (${[...distinct].join(', ')})`)
  } finally {
    await client.close()
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(closePool)
