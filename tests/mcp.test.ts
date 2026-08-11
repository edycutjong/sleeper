/**
 * Unit tests for the CockroachDB Cloud Managed MCP Server client.
 *
 * These run with NO credentials and NO network — everything asserted here is the part of the
 * integration that has to be right *before* the first byte leaves: which path gets chosen and
 * why, the exact headers, the documented per-call limits, how a request is shaped against the
 * schema the server advertises, and how a response is read back.
 *
 * Env is passed explicitly into every function under test rather than mutated globally, so these
 * cannot leak into each other or into whatever is in the developer's .env.
 */
import { describe, expect, it } from 'vitest'
import { config } from '../src/config.js'
import {
  CockroachMcpClient,
  MCP_ENDPOINT,
  MCP_MAX_STATEMENT_CHARS,
  MCP_TOOLS,
  McpLimitError,
  McpResultError,
  McpToolError,
  McpValueError,
  assertReadOnlyTools,
  assertSingleStatement,
  assertUuid,
  hasExplicitLimit,
  writeCapableTools,
  mcpHeaders,
  parseRows,
  planProbeVector,
  renderContent,
  resolveMcpMode,
  resolveSqlReader,
  shapeArguments,
  splitStatements,
  sqlLiteral,
  vectorLiteral,
  type McpCallResult,
  type McpLike,
  type McpToolDef,
  type SqlReader,
} from '../src/mcp.js'
import { EVIDENCE_SQL, holdEvidence, scopedNeighbourExplainSql } from '../src/memory.js'

const HOLD_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const ARC_ID = '9c858901-8a57-4791-81fe-4c455b099bc9'

/** A tool schema shaped the way the real server plausibly declares one. */
function toolDef(name: string, properties: Record<string, object>, required: string[] = []): McpToolDef {
  return { name, inputSchema: { type: 'object', properties, required } }
}

const SERVER_TOOLS: McpToolDef[] = [
  toolDef(MCP_TOOLS.select, { sql: { type: 'string' } }, ['sql']),
  toolDef(MCP_TOOLS.explain, { sql: { type: 'string' } }, ['sql']),
  toolDef(MCP_TOOLS.tableSchema, { table: { type: 'string' }, database: { type: 'string' } }, ['table']),
  toolDef(MCP_TOOLS.show, { sql: { type: 'string' } }, ['sql']),
]

/** A stand-in for the SDK client, recording exactly what the transport would have been handed. */
function fakeServer(options: {
  tools?: McpToolDef[]
  respond?: (name: string, args: Record<string, unknown>) => McpCallResult
} = {}) {
  const sent: { name: string; args: Record<string, unknown>; timeout?: number }[] = []
  let closed = false
  const client: McpLike = {
    async listTools() {
      return { tools: options.tools ?? SERVER_TOOLS }
    },
    async callTool(params, _schema, callOptions) {
      sent.push({ name: params.name, args: params.arguments ?? {}, timeout: callOptions?.timeout })
      return (
        options.respond?.(params.name, params.arguments ?? {}) ?? {
          content: [{ type: 'text', text: '[]' }],
        }
      )
    },
    async close() {
      closed = true
    },
  }
  return { client, sent, isClosed: () => closed }
}

async function connected(options?: Parameters<typeof fakeServer>[0]) {
  const server = fakeServer(options)
  const client = new CockroachMcpClient({ clientFactory: async () => server.client }, 'test')
  await client.connect()
  return { client, server }
}

describe('resolveMcpMode — the fallback decision', () => {
  it('falls back to direct SQL when no API key is configured, and says which var is missing', () => {
    const mode = resolveMcpMode({})
    expect(mode.via).toBe('direct')
    expect(mode.reason).toContain('COCKROACH_MCP_API_KEY')
  })

  it('takes the MCP path once a key is present', () => {
    const mode = resolveMcpMode({ COCKROACH_MCP_API_KEY: 'sk-test' })
    expect(mode.via).toBe('mcp')
    expect(mode).toMatchObject({ endpoint: MCP_ENDPOINT, clusterPinned: false })
  })

  it('reports the session as pinned when a cluster id is configured', () => {
    const mode = resolveMcpMode({ COCKROACH_MCP_API_KEY: 'sk-test', COCKROACH_CLUSTER_ID: 'cl-1' })
    expect(mode).toMatchObject({ via: 'mcp', clusterPinned: true })
    expect(mode.reason).toContain('cl-1')
  })

  it('warns in the reason when a key can reach every cluster the account can see', () => {
    const mode = resolveMcpMode({ COCKROACH_MCP_API_KEY: 'sk-test' })
    expect(mode.reason).toMatch(/COCKROACH_CLUSTER_ID is NOT set/)
  })

  it('honours SLEEPER_MCP=off even with credentials present, so both paths can be demoed', () => {
    const mode = resolveMcpMode({ COCKROACH_MCP_API_KEY: 'sk-test', SLEEPER_MCP: 'off' })
    expect(mode.via).toBe('direct')
    expect(mode.reason).toContain('SLEEPER_MCP=off')
  })

  it('honours an endpoint override', () => {
    const mode = resolveMcpMode({ COCKROACH_MCP_API_KEY: 'k', COCKROACH_MCP_URL: 'https://example/mcp' })
    expect(mode).toMatchObject({ via: 'mcp', endpoint: 'https://example/mcp' })
  })
})

describe('mcpHeaders — the documented API-key auth', () => {
  it('sends the service-account key as a bearer token', () => {
    expect(mcpHeaders({ apiKey: 'sk-abc' })).toEqual({ Authorization: 'Bearer sk-abc' })
  })

  it('pins the session to one cluster with the mcp-cluster-id header', () => {
    expect(mcpHeaders({ apiKey: 'sk-abc', clusterId: 'cl-9' })).toEqual({
      Authorization: 'Bearer sk-abc',
      'mcp-cluster-id': 'cl-9',
    })
  })

  it('omits the pin rather than sending it empty — an empty pin would look like a pin', () => {
    expect(mcpHeaders({ apiKey: 'sk-abc', clusterId: '' })).not.toHaveProperty('mcp-cluster-id')
    expect(mcpHeaders({ apiKey: 'sk-abc', clusterId: null })).not.toHaveProperty('mcp-cluster-id')
  })

  it('refuses to build headers with no key', () => {
    expect(() => mcpHeaders({ apiKey: '' })).toThrow(/apiKey is required/)
  })
})

describe('statement limits — one statement per call, ≤16,384 chars', () => {
  it('splits on real statement boundaries', () => {
    expect(splitStatements('SELECT 1; SELECT 2')).toHaveLength(2)
  })

  it('does not treat a semicolon inside a string literal as a boundary', () => {
    const sql = `SELECT * FROM audit_log WHERE detail = 'held; advisory queued' LIMIT 1`
    expect(splitStatements(sql)).toEqual([sql])
  })

  it('does not treat a semicolon inside a comment as a boundary', () => {
    expect(splitStatements('SELECT 1 -- one; two\n')).toHaveLength(1)
    expect(splitStatements('SELECT /* a; b */ 1')).toHaveLength(1)
  })

  it('tolerates a trailing semicolon and strips it', () => {
    expect(assertSingleStatement('SELECT 1 LIMIT 1;')).toBe('SELECT 1 LIMIT 1')
  })

  it('rejects two statements instead of quietly sending only the first', () => {
    expect(() => assertSingleStatement('SELECT 1; DROP TABLE events')).toThrow(McpLimitError)
    expect(() => assertSingleStatement('SELECT 1; SELECT 2')).toThrow(/exactly ONE statement/)
  })

  it('rejects an empty or comment-only call', () => {
    expect(() => assertSingleStatement('   ')).toThrow(McpLimitError)
    expect(() => assertSingleStatement('-- nothing here')).toThrow(McpLimitError)
  })

  it('rejects a statement over the documented 16,384-char ceiling', () => {
    const huge = `SELECT '${'x'.repeat(MCP_MAX_STATEMENT_CHARS)}' LIMIT 1`
    expect(() => assertSingleStatement(huge)).toThrow(/16384/)
  })

  it('detects whether a SELECT bounds itself, since an unbounded one is capped at 25 rows', () => {
    expect(hasExplicitLimit('SELECT 1 LIMIT 10')).toBe(true)
    expect(hasExplicitLimit('SELECT 1')).toBe(false)
  })

  // The dangerous direction of the same lexical problem the literal-semicolon test covers. A
  // statement whose *data* contains the characters "limit 25" is unbounded; counting it as bounded
  // sends it, lets the server apply its implicit LIMIT 25, and presents a truncated audit trail
  // as a complete one — the exact failure the LIMIT guard exists to make impossible.
  it('does not count "limit 25" inside a string literal as a bound', () => {
    expect(hasExplicitLimit(`SELECT detail FROM audit_log WHERE detail = 'limit 25 exceeded'`)).toBe(false)
    expect(hasExplicitLimit(`SELECT 1 WHERE a = 'x' AND b = 'limit 9' LIMIT 3`)).toBe(true)
  })

  it('does not count a LIMIT inside a comment or a quoted identifier as a bound', () => {
    expect(hasExplicitLimit('SELECT detail FROM audit_log -- limit 25\n')).toBe(false)
    expect(hasExplicitLimit('SELECT /* limit 9 */ detail FROM audit_log')).toBe(false)
    expect(hasExplicitLimit('SELECT "limit 5" FROM t')).toBe(false)
  })

  it('treats LIMIT ALL as unbounded, because it is', () => {
    expect(hasExplicitLimit('SELECT 1 LIMIT ALL')).toBe(false)
  })

  it('rejects an unbounded SELECT whose literal merely mentions a limit', async () => {
    const { client, server } = await connected()
    await expect(
      client.select(`SELECT detail FROM audit_log WHERE detail = 'limit 25 exceeded'`),
    ).rejects.toThrow(McpLimitError)
    expect(server.sent).toHaveLength(0)
  })
})

describe('SQL literal construction — there is no bind-parameter channel over MCP', () => {
  it('escapes embedded quotes rather than concatenating raw input', () => {
    expect(sqlLiteral("o'brien")).toBe("'o''brien'")
    expect(sqlLiteral("'; DROP TABLE events; --")).toBe("'''; DROP TABLE events; --'")
  })

  it('keeps an injected literal to a single statement even when it contains semicolons', () => {
    const sql = `SELECT status FROM trust_state WHERE package_id = ${sqlLiteral("a'; DELETE FROM events; --")} LIMIT 1`
    expect(splitStatements(sql)).toHaveLength(1)
  })

  it('validates a UUID before inlining it', () => {
    expect(assertUuid(HOLD_ID)).toBe(HOLD_ID)
    expect(() => assertUuid("' OR 1=1 --")).toThrow(/Not a UUID/)
    expect(() => assertUuid('')).toThrow(/Not a UUID/)
  })
})

describe('vectorLiteral — 1024 dimensions inside a 16,384-char statement', () => {
  const probe = planProbeVector(1024)

  it('produces a well-formed pgvector literal of the right width', () => {
    const literal = vectorLiteral([0.5, -0.25, 0])
    expect(literal).toBe('[0.5,-0.25,0]')
    expect(vectorLiteral(probe).split(',')).toHaveLength(1024)
  })

  it('keeps a full-width EXPLAIN statement under the server limit', () => {
    const sql = scopedNeighbourExplainSql('xz-utils', probe, 20)
    expect(sql.length).toBeLessThan(MCP_MAX_STATEMENT_CHARS)
    expect(() => assertSingleStatement(sql)).not.toThrow()
  })

  it('would blow the limit at full float precision — which is why the literal is rounded', () => {
    const sql = scopedNeighbourExplainSql('xz-utils', probe, 20, 17)
    expect(sql.length).toBeGreaterThan(MCP_MAX_STATEMENT_CHARS)
    expect(() => assertSingleStatement(sql)).toThrow(McpLimitError)
  })

  it('still asks for the prefix-scoped plan the demo claims on camera', () => {
    const sql = scopedNeighbourExplainSql('xz-utils', probe, 20)
    expect(sql).toContain("WHERE package_id = 'xz-utils'")
    expect(sql).toContain('ORDER BY embedding <=>')
    expect(sql).toContain('LIMIT 20')
  })

  it('quotes the package id rather than concatenating it', () => {
    expect(scopedNeighbourExplainSql("x'; DROP TABLE events; --", planProbeVector(4), 5)).toContain(
      "WHERE package_id = 'x''; DROP TABLE events; --'",
    )
  })

  // `[1,NaN,Infinity]` is well-formed enough to pass every other check in the client and is
  // rejected only by the server, as an opaque parse error on a 16 KB statement. A non-finite
  // component means the embedding upstream is broken; the error should say that.
  it('refuses a non-finite component instead of printing NaN into the literal', () => {
    expect(() => vectorLiteral([1, NaN, 0])).toThrow(McpValueError)
    expect(() => vectorLiteral([1, NaN, 0])).toThrow(/component 1 is NaN/)
    expect(() => vectorLiteral([0, Infinity])).toThrow(/component 1 is Infinity/)
    expect(() => vectorLiteral([0, -Infinity])).toThrow(McpValueError)
    expect(vectorLiteral([0, -0, 1e-9])).toBe('[0,0,0]')
  })
})

describe('EVIDENCE_SQL — the five audit statements', () => {
  const statements = [
    EVIDENCE_SQL.hold(HOLD_ID),
    EVIDENCE_SQL.matchedArc(ARC_ID),
    EVIDENCE_SQL.trust('xz-utils'),
    EVIDENCE_SQL.advisories(HOLD_ID),
    EVIDENCE_SQL.auditTrail(HOLD_ID),
  ]

  it('are each exactly one statement inside the size limit', () => {
    for (const sql of statements) expect(() => assertSingleStatement(sql)).not.toThrow()
  })

  it('all carry an explicit LIMIT, so the implicit LIMIT 25 can never truncate the trail', () => {
    for (const sql of statements) expect(hasExplicitLimit(sql)).toBe(true)
  })

  it('cast timestamps to STRING so the MCP and direct paths agree on the wire', () => {
    expect(EVIDENCE_SQL.hold(HOLD_ID)).toContain('created_at::STRING')
    expect(EVIDENCE_SQL.auditTrail(HOLD_ID)).toContain('created_at::STRING')
  })

  it('refuse a hold id that is not a UUID', () => {
    expect(() => EVIDENCE_SQL.hold("' OR 1=1 --")).toThrow(/Not a UUID/)
    expect(() => EVIDENCE_SQL.advisories('../../etc/passwd')).toThrow(/Not a UUID/)
  })
})

describe('shapeArguments — binding to the schema the server advertises', () => {
  it('uses the property name the server actually declared', () => {
    expect(shapeArguments(toolDef('t', { sql: {} }), { sql: 'SELECT 1' })).toEqual({ sql: 'SELECT 1' })
    expect(shapeArguments(toolDef('t', { statement: {} }), { sql: 'SELECT 1' })).toEqual({
      statement: 'SELECT 1',
    })
    expect(shapeArguments(toolDef('t', { query: {} }), { sql: 'SELECT 1' })).toEqual({
      query: 'SELECT 1',
    })
  })

  it('drops arguments the caller did not supply instead of sending undefined', () => {
    const tool = toolDef(MCP_TOOLS.tableSchema, { table: {}, database: {} }, ['table'])
    expect(shapeArguments(tool, { table: 'events', database: undefined })).toEqual({ table: 'events' })
  })

  it('falls back to the canonical name when the server publishes an open schema', () => {
    expect(shapeArguments(toolDef('t', {}), { sql: 'SELECT 1' })).toEqual({ sql: 'SELECT 1' })
  })

  it('names the properties the server does declare when nothing matches', () => {
    expect(() => shapeArguments(toolDef('t', { stmt: {} }), { sql: 'SELECT 1' })).toThrow(
      /Server declares: stmt/,
    )
  })

  it('refuses to send a call missing a required argument', () => {
    const tool = toolDef(MCP_TOOLS.tableSchema, { table: {}, database: {} }, ['table', 'database'])
    expect(() => shapeArguments(tool, { table: 'events' })).toThrow(/requires database/)
  })
})

describe('response handling', () => {
  it('joins the text blocks of a result', () => {
    expect(renderContent({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, 't')).toBe(
      'a\nb',
    )
  })

  it('turns a tool-level error into a thrown one instead of a silent empty result', () => {
    expect(() =>
      renderContent({ isError: true, content: [{ type: 'text', text: 'permission denied' }] }, 'select_query'),
    ).toThrow(/permission denied/)
  })

  it('reads rows out of a bare JSON array', () => {
    expect(parseRows('[{"id":1}]')).toEqual({ rows: [{ id: 1 }], format: 'json-array' })
  })

  it('reads rows out of a wrapper object, whichever key it uses', () => {
    expect(parseRows('{"rows":[{"id":1}]}').rows).toEqual([{ id: 1 }])
    expect(parseRows('{"data":[{"id":2}]}').rows).toEqual([{ id: 2 }])
    expect(parseRows('{"results":[{"id":3}]}').format).toBe('json-object.results')
  })

  it('reads newline-delimited JSON', () => {
    expect(parseRows('{"id":1}\n{"id":2}')).toEqual({
      rows: [{ id: 1 }, { id: 2 }],
      format: 'ndjson',
    })
  })

  it('reports an unrecognised payload rather than pretending there were zero rows', () => {
    expect(parseRows('id | name\n1  | x').format).toBe('unparsed')
    expect(parseRows('   ').format).toBe('empty')
  })

  // A bare JSON object with no rows/data/results/records array is not a result set. Wrapping it as
  // "one row" fabricated evidence: every column read off it was undefined, `similarity` coerced to
  // NaN, `created_at` to an Invalid Date, and `npm run explain` died with `RangeError: Invalid
  // time value` — a stack trace where the operator needed a sentence.
  it('does not fabricate a row out of an object that is not a result set', () => {
    expect(parseRows('{"note":"no rows returned"}')).toEqual({
      rows: [],
      format: 'json-object.unrecognised',
    })
  })

  it('throws with the server’s own words when the payload is an error it did not flag', () => {
    expect(() => parseRows('{"error":"permission denied","code":42501}')).toThrow(McpResultError)
    expect(() => parseRows('{"error":"permission denied","code":42501}')).toThrow(/permission denied/)
    // `isError` unset is the whole point: this is the shape that got past renderContent.
    expect(() => parseRows('{"message":"relation does not exist","code":"42P01"}')).toThrow(
      /relation does not exist/,
    )
  })

  it('still reads a legitimate row whose own column happens to be called error', () => {
    // The wrapper keys are checked first, so a real result set is never mistaken for a failure.
    expect(parseRows('{"rows":[{"error":"handled"}]}').rows).toEqual([{ error: 'handled' }])
  })
})

describe('CockroachMcpClient — request shaping and limits, end to end without a server', () => {
  it('caches tools/list at connect and reports what the session can reach', async () => {
    const { client } = await connected()
    expect(client.availableTools()).toEqual(
      [MCP_TOOLS.explain, MCP_TOOLS.tableSchema, MCP_TOOLS.select, MCP_TOOLS.show].sort(),
    )
    expect(client.calls).toEqual(['tools/list'])
  })

  it('sends select_query with the statement shaped to the declared argument name', async () => {
    const { client, server } = await connected({
      respond: () => ({ content: [{ type: 'text', text: '[{"id":"h1"}]' }] }),
    })
    const rows = await client.select<{ id: string }>('SELECT id FROM release_hold LIMIT 1')
    expect(rows).toEqual([{ id: 'h1' }])
    expect(server.sent[0]).toMatchObject({
      name: MCP_TOOLS.select,
      args: { sql: 'SELECT id FROM release_hold LIMIT 1' },
      timeout: 20_000,
    })
  })

  it('refuses an unbounded SELECT rather than letting the server cap it at 25 rows', async () => {
    const { client, server } = await connected()
    await expect(client.select('SELECT id FROM audit_log')).rejects.toThrow(McpLimitError)
    expect(server.sent).toHaveLength(0)
  })

  it('rejects a two-statement call before it reaches the transport', async () => {
    const { client, server } = await connected()
    await expect(client.explain('SELECT 1; SELECT 2')).rejects.toThrow(McpLimitError)
    expect(server.sent).toHaveLength(0)
  })

  it('drives get_table_schema and show_statement through their own tools', async () => {
    const { client, server } = await connected({
      respond: (name) => ({ content: [{ type: 'text', text: `ran ${name}` }] }),
    })
    expect(await client.tableSchema('release_hold')).toBe(`ran ${MCP_TOOLS.tableSchema}`)
    expect(await client.show('SHOW DATABASE')).toBe(`ran ${MCP_TOOLS.show}`)
    expect(server.sent.map((s) => s.name)).toEqual([MCP_TOOLS.tableSchema, MCP_TOOLS.show])
    expect(server.sent[0]!.args).toEqual({ table: 'release_hold' })
  })

  it('records every tool it drove, so npm run mcp:audit can print the trail', async () => {
    const { client } = await connected({
      respond: () => ({ content: [{ type: 'text', text: '[]' }] }),
    })
    await client.explain('SELECT 1 LIMIT 1')
    await client.select('SELECT 1 LIMIT 1')
    await client.tableSchema('events')
    expect(client.calls).toEqual([
      'tools/list',
      MCP_TOOLS.explain,
      MCP_TOOLS.select,
      MCP_TOOLS.tableSchema,
    ])
  })

  it('says which tools the session DOES have when one is missing', async () => {
    const { client } = await connected({ tools: [toolDef(MCP_TOOLS.select, { sql: {} })] })
    await expect(client.tableSchema('events')).rejects.toThrow(McpToolError)
    await expect(client.tableSchema('events')).rejects.toThrow(/Available: select_query/)
  })

  it('refuses to call anything before connect()', async () => {
    const client = new CockroachMcpClient({ clientFactory: async () => fakeServer().client })
    await expect(client.select('SELECT 1 LIMIT 1')).rejects.toThrow(/connect\(\) has not been called/)
  })

  it('passes the database through to get_table_schema when one is supplied', async () => {
    const { client, server } = await connected({
      respond: () => ({ content: [{ type: 'text', text: 'CREATE TABLE …' }] }),
    })
    await client.tableSchema('release_hold', 'sleeper')
    expect(server.sent[0]!.args).toEqual({ table: 'release_hold', database: 'sleeper' })
  })

  // The failure this prevents is the likely first-live-run one: a cluster-scoped session has no
  // session database, so if the server declares `database` REQUIRED, a call that cannot supply it
  // dies in shapeArguments before anything is dialled.
  it('can satisfy a get_table_schema that declares database REQUIRED', async () => {
    const strict = [
      toolDef(MCP_TOOLS.tableSchema, { table: {}, database: {} }, ['table', 'database']),
    ]
    const { client, server } = await connected({
      tools: strict,
      respond: () => ({ content: [{ type: 'text', text: 'CREATE TABLE …' }] }),
    })
    await expect(client.tableSchema('events')).rejects.toThrow(/requires database/)
    await client.tableSchema('events', 'sleeper')
    expect(server.sent).toHaveLength(1)
    expect(server.sent[0]!.args).toEqual({ table: 'events', database: 'sleeper' })
  })

  it('holds selectRaw to the same LIMIT guard as select, and reports the encoding', async () => {
    const { client, server } = await connected({
      respond: () => ({ content: [{ type: 'text', text: '{"rows":[{"id":"h1"}]}' }] }),
    })
    await expect(client.selectRaw('SELECT id FROM audit_log')).rejects.toThrow(McpLimitError)
    expect(server.sent).toHaveLength(0)
    const raw = await client.selectRaw<{ id: string }>('SELECT id FROM audit_log LIMIT 5')
    expect(raw).toMatchObject({ rows: [{ id: 'h1' }], format: 'json-object.rows' })
  })
})

describe('the read-only claim, checked instead of asserted', () => {
  it('accepts the four read tools this project drives', () => {
    expect(writeCapableTools(Object.values(MCP_TOOLS))).toEqual([])
    expect(() => assertReadOnlyTools(Object.values(MCP_TOOLS))).not.toThrow()
  })

  it('flags a write tool by name', () => {
    expect(writeCapableTools(['select_query', 'insert_rows'])).toEqual(['insert_rows'])
    expect(writeCapableTools(['create_table', 'execute_sql', 'run_ddl'])).toEqual([
      'create_table',
      'execute_sql',
      'run_ddl',
    ])
  })

  it('does not flag a reader whose name merely contains a write verb', () => {
    expect(writeCapableTools(['show_create_table', 'get_create_statement'])).toEqual([])
  })

  // What `npm run mcp:audit` does with the same call: the README tells a distro packager the audit
  // path is read-only at the protocol layer, and that is only true while the service account holds
  // a read-only cluster role. A session advertising insert_rows must fail the audit, not warn.
  it('fails on a session that advertises a write tool, naming the role to fix', async () => {
    const { client } = await connected({
      tools: [...SERVER_TOOLS, toolDef('insert_rows', { table: {}, rows: {} }, ['table', 'rows'])],
    })
    expect(client.availableTools()).toContain('insert_rows')
    expect(() => assertReadOnlyTools(client.availableTools())).toThrow(McpToolError)
    expect(() => assertReadOnlyTools(client.availableTools())).toThrow(/insert_rows/)
    expect(() => assertReadOnlyTools(client.availableTools())).toThrow(/SLEEPER_MCP_ROLE/)
  })
})

describe('config.databaseName — the database an MCP tool call has to name for itself', () => {
  it('derives the database from DATABASE_URL rather than asking for it twice', () => {
    expect(config.databaseName({ DATABASE_URL: 'postgresql://root@localhost:26257/sleeper?sslmode=disable' })).toBe(
      'sleeper',
    )
    expect(
      config.databaseName({
        DATABASE_URL: 'postgresql://u:p@free-tier.gcp.cockroachlabs.cloud:26257/sleeper-cluster.defaultdb',
      }),
    ).toBe('sleeper-cluster.defaultdb')
  })

  it('lets SLEEPER_DATABASE win, since provision.sh uses the same override', () => {
    expect(config.databaseName({ DATABASE_URL: 'postgresql://h/a', SLEEPER_DATABASE: 'b' })).toBe('b')
  })

  it('returns null instead of throwing when there is nothing to derive from', () => {
    // An MCP-only checkout must still be able to dial the server, and a server that does not
    // require the argument must not be blocked by a var it never uses.
    expect(config.databaseName({})).toBeNull()
    expect(config.databaseName({ DATABASE_URL: 'postgresql://host:26257/' })).toBeNull()
    expect(config.databaseName({ DATABASE_URL: 'not a url' })).toBeNull()
  })
})

describe('resolveSqlReader — the fallback is explicit, never silent', () => {
  const directReader = (reason: string): SqlReader => ({
    via: 'direct',
    reason,
    calls: [],
    async select() {
      return []
    },
    async explain() {
      return ''
    },
    async tableSchema() {
      return ''
    },
    async close() {},
  })

  it('returns the direct reader, carrying the reason, when MCP is not configured', async () => {
    const reader = await resolveSqlReader(directReader, {})
    expect(reader.via).toBe('direct')
    expect(reader.reason).toContain('COCKROACH_MCP_API_KEY')
  })

  it('returns a connected MCP reader when it is configured', async () => {
    const server = fakeServer()
    const reader = await resolveSqlReader(
      directReader,
      { COCKROACH_MCP_API_KEY: 'sk', COCKROACH_CLUSTER_ID: 'cl-1' },
      async () => server.client,
    )
    expect(reader.via).toBe('mcp')
    expect(reader.reason).toContain('cl-1')
  })

  it('falls back — loudly, naming the error — when a configured session cannot be established', async () => {
    const reader = await resolveSqlReader(directReader, { COCKROACH_MCP_API_KEY: 'sk' }, async () => {
      throw new Error('401 Unauthorized')
    })
    expect(reader.via).toBe('direct')
    expect(reader.reason).toContain('401 Unauthorized')
    expect(reader.reason).toContain('fell back to direct SQL')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Fixture replay
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recorded-shape payloads, replayed through the real `CockroachMcpClient`.
 *
 * The honest limitation of this whole file is stated plainly: this client has never been run
 * against the live Managed MCP Server, because we have no service-account key. Fixtures are the
 * strongest substitute available — not proof the server answers this way, but a pinned contract.
 * If the live server disagrees, the disagreement surfaces as a specific failing expectation in a
 * suite that runs in 20 ms, instead of as a stack trace mid-demo.
 *
 * The unhappy paths matter more here than the happy one. Three are recorded because all three are
 * things a real server does: a tool-level error with `isError` set, a permission failure returned
 * as a plain JSON object with `isError` NOT set (the shape that used to be silently turned into a
 * fabricated row), and a non-row informational payload.
 */
const FIXTURES = {
  /** `select_query` on the hold — one row, wrapped, every scalar a JSON string. */
  hold: JSON.stringify({
    columns: ['id', 'package_id', 'release_version', 'reason', 'similarity', 'created_at', 'matched_playbook_id'],
    rows: [
      {
        id: HOLD_ID,
        package_id: 'xz-utils',
        release_version: '5.6.0',
        reason: 'arc matches a known takeover shape',
        similarity: '0.8731',
        created_at: '2024-02-24 00:00:00+00',
        matched_playbook_id: ARC_ID,
      },
    ],
  }),
  matchedArc: JSON.stringify({
    rows: [{ package_id: 'event-stream', label: 'takeover', source: 'synthetic', arc_summary: 'arc' }],
  }),
  trust: JSON.stringify({ rows: [{ status: 'held' }] }),
  advisories: JSON.stringify({
    rows: [{ id: 'a1', advisory_text: 'Hold 5.6.0 pending review', sent: 'false' }],
  }),
  auditTrail: JSON.stringify({
    rows: [
      { actor: 'agent', action: 'hold', detail: null, created_at: '2024-02-24 00:00:01+00' },
      { actor: 'agent', action: 'advisory_queued', detail: 'debian', created_at: '2024-02-24 00:00:01+00' },
    ],
  }),
  /** No rows at all — a legitimately empty result set, not an error. */
  noRows: JSON.stringify({ rows: [] }),

  /** `explain_query` — CockroachDB's plan text, as the server renders it. */
  plan: [
    'distribution: local',
    'vectorized: true',
    '',
    '• vector search',
    '│ table: events@events_package_embedding_idx',
    '│ prefix spans: 1 span',
    '│ target count: 20',
    '',
    '└── • scan',
    '      table: events@events_pkey',
  ].join('\n'),

  /** `get_table_schema` — SHOW CREATE TABLE as the cluster describes it. */
  tableSchema: [
    'CREATE TABLE public.release_hold (',
    '\tid UUID NOT NULL DEFAULT gen_random_uuid(),',
    '\tpackage_id STRING NOT NULL,',
    '\trelease_version STRING NOT NULL,',
    '\tsimilarity FLOAT8 NOT NULL,',
    '\tcreated_at TIMESTAMPTZ NOT NULL DEFAULT now(),',
    '\tCONSTRAINT release_hold_pkey PRIMARY KEY (id ASC)',
    ')',
  ].join('\n'),

  /** A failure the server DID flag — `renderContent` must turn this into a thrown error. */
  toolError: {
    isError: true,
    content: [{ type: 'text', text: 'ERROR: user sleeper-mcp does not have SELECT privilege on relation release_hold' }],
  } satisfies McpCallResult,

  /** A failure the server did NOT flag. This is the B2 shape: valid JSON, no `isError`, no rows. */
  permissionDeniedPayload: JSON.stringify({ error: 'permission denied for table release_hold', code: '42501' }),

  /** A non-row informational payload — must not become a row either. */
  notePayload: JSON.stringify({ note: 'no rows returned' }),
} as const

/** Serves the five evidence statements from fixtures, keyed off the table each one reads. */
function evidenceFixtureFor(sql: string): string {
  if (sql.includes('FROM release_hold')) return FIXTURES.hold
  if (sql.includes('FROM takeover_playbook')) return FIXTURES.matchedArc
  if (sql.includes('FROM trust_state')) return FIXTURES.trust
  if (sql.includes('FROM distro_advisory_outbox')) return FIXTURES.advisories
  if (sql.includes('FROM audit_log')) return FIXTURES.auditTrail
  return FIXTURES.noRows
}

describe('fixture replay — the recorded contract this client will meet on its first live run', () => {
  /** A server that answers every tool from the fixtures above, with a per-tool override hook. */
  function replayServer(override?: (name: string, sql: string) => McpCallResult | undefined) {
    return fakeServer({
      respond: (name, args) => {
        const sql = String(args.sql ?? '')
        const overridden = override?.(name, sql)
        if (overridden) return overridden
        if (name === MCP_TOOLS.select) return { content: [{ type: 'text', text: evidenceFixtureFor(sql) }] }
        if (name === MCP_TOOLS.explain) return { content: [{ type: 'text', text: FIXTURES.plan }] }
        if (name === MCP_TOOLS.tableSchema) return { content: [{ type: 'text', text: FIXTURES.tableSchema }] }
        if (name === MCP_TOOLS.show) return { content: [{ type: 'text', text: 'sleeper' }] }
        return { content: [{ type: 'text', text: FIXTURES.noRows }] }
      },
    })
  }

  async function replayClient(override?: Parameters<typeof replayServer>[0]) {
    const server = replayServer(override)
    const client = new CockroachMcpClient({ clientFactory: async () => server.client }, 'fixture replay')
    await client.connect()
    return { client, server }
  }

  it('reads a wrapped select_query payload as rows, reporting the encoding it found', async () => {
    const { client } = await replayClient()
    const raw = await client.selectRaw<{ id: string }>(EVIDENCE_SQL.hold(HOLD_ID))
    expect(raw.format).toBe('json-object.rows')
    expect(raw.rows[0]!.id).toBe(HOLD_ID)
  })

  it('carries the whole five-call evidence trail through the real client', async () => {
    const { client } = await replayClient()
    const evidence = await holdEvidence(HOLD_ID, client)
    expect(evidence).not.toBeNull()
    expect(evidence!.hold.releaseVersion).toBe('5.6.0')
    expect(evidence!.hold.similarity).toBeCloseTo(0.8731)
    expect(Number.isNaN(evidence!.hold.createdAt.getTime())).toBe(false)
    expect(evidence!.trustStatus).toBe('held')
    expect(evidence!.matchedArc?.label).toBe('takeover')
    expect(evidence!.advisories[0]!.sent).toBe(false)
    expect(evidence!.auditTrail).toHaveLength(2)
    // Five select_query calls and nothing else — the audit is reads only, one statement each.
    expect(client.calls.filter((c) => c === MCP_TOOLS.select)).toHaveLength(5)
    expect(new Set(client.calls)).toEqual(new Set(['tools/list', MCP_TOOLS.select]))
  })

  it('keeps the prefix-spans proof the demo claims, in the shape the audit greps for', async () => {
    const { client } = await replayClient()
    const plan = await client.explain(
      `SELECT id FROM events WHERE package_id = 'xz-utils' ORDER BY embedding <=> '[0]'::VECTOR LIMIT 20`,
    )
    // Same two regexes scripts/mcp-audit.ts prints its verdict from.
    expect(/prefix spans:/i.test(plan)).toBe(true)
    expect(/vector search/i.test(plan)).toBe(true)
  })

  it('returns the cluster’s own CREATE TABLE text from get_table_schema', async () => {
    const { client } = await replayClient()
    const schema = await client.tableSchema('release_hold', 'sleeper')
    expect(schema).toContain('CREATE TABLE public.release_hold')
    expect(schema).toContain('similarity FLOAT8 NOT NULL')
  })

  it('turns a flagged tool error into a thrown error carrying the server’s message', async () => {
    const { client } = await replayClient((name) => (name === MCP_TOOLS.select ? FIXTURES.toolError : undefined))
    await expect(client.select(EVIDENCE_SQL.hold(HOLD_ID))).rejects.toThrow(McpToolError)
    await expect(client.select(EVIDENCE_SQL.hold(HOLD_ID))).rejects.toThrow(/does not have SELECT privilege/)
  })

  // The one that used to be silent, and the reason this whole block exists. The service account
  // cannot read release_hold; the server says so in a JSON body without setting isError. Before
  // the fix this became one fabricated row, holdEvidence returned a non-null object with
  // similarity NaN and an Invalid Date, and the first symptom was `RangeError: Invalid time value`
  // thrown from `scripts/explain.ts` while printing it.
  it('refuses an unflagged permission failure instead of fabricating a row from it', async () => {
    const { client } = await replayClient((name) =>
      name === MCP_TOOLS.select
        ? { content: [{ type: 'text', text: FIXTURES.permissionDeniedPayload }] }
        : undefined,
    )
    await expect(client.select(EVIDENCE_SQL.hold(HOLD_ID))).rejects.toThrow(McpResultError)
    await expect(holdEvidence(HOLD_ID, client)).rejects.toThrow(/permission denied for table release_hold/)
  })

  it('treats a non-row informational payload as no rows, so holdEvidence reports nothing found', async () => {
    const { client } = await replayClient((name) =>
      name === MCP_TOOLS.select ? { content: [{ type: 'text', text: FIXTURES.notePayload }] } : undefined,
    )
    expect(await client.select(EVIDENCE_SQL.hold(HOLD_ID))).toEqual([])
    // Null — "no such hold" — rather than an evidence object built out of nothing.
    expect(await holdEvidence(HOLD_ID, client)).toBeNull()
  })

  it('reads an empty result set as empty without inventing a hold', async () => {
    const { client } = await replayClient((name) =>
      name === MCP_TOOLS.select ? { content: [{ type: 'text', text: FIXTURES.noRows }] } : undefined,
    )
    expect(await holdEvidence(HOLD_ID, client)).toBeNull()
  })

  it('sends every evidence statement as one statement inside the documented limits', async () => {
    const { client, server } = await replayClient()
    await holdEvidence(HOLD_ID, client)
    expect(server.sent).toHaveLength(5)
    for (const call of server.sent) {
      const sql = String(call.args.sql)
      expect(assertSingleStatement(sql)).toBe(sql)
      expect(sql.length).toBeLessThanOrEqual(MCP_MAX_STATEMENT_CHARS)
      expect(hasExplicitLimit(sql)).toBe(true)
      expect(call.timeout).toBe(20_000)
    }
  })
})

describe('holdEvidence over the MCP reader', () => {
  /** The MCP path returns JSON, so every scalar arrives as a string. Direct SQL returns natives. */
  const mcpShaped: SqlReader = {
    via: 'mcp',
    reason: 'test',
    calls: [],
    async select<T>(sql: string): Promise<T[]> {
      if (sql.includes('FROM release_hold')) {
        return [
          {
            id: HOLD_ID,
            package_id: 'xz-utils',
            release_version: '5.6.0',
            reason: 'arc matches a known takeover shape',
            similarity: '0.8731',
            created_at: '2024-02-24T00:00:00Z',
            matched_playbook_id: ARC_ID,
          },
        ] as T[]
      }
      if (sql.includes('FROM takeover_playbook')) {
        return [
          { package_id: 'event-stream', label: 'takeover', source: 'synthetic', arc_summary: 'arc' },
        ] as T[]
      }
      if (sql.includes('FROM trust_state')) return [{ status: 'held' }] as T[]
      if (sql.includes('FROM distro_advisory_outbox')) {
        return [{ id: 'a1', advisory_text: 'Hold 5.6.0', sent: 'false' }] as T[]
      }
      if (sql.includes('FROM audit_log')) {
        return [
          { actor: 'agent', action: 'hold', detail: null, created_at: '2024-02-24T00:00:01Z' },
        ] as T[]
      }
      return [] as T[]
    },
    async explain() {
      return ''
    },
    async tableSchema() {
      return ''
    },
    async close() {},
  }

  it('normalises the JSON-shaped rows into the same evidence object the direct path returns', async () => {
    const evidence = await holdEvidence(HOLD_ID, mcpShaped)
    expect(evidence).not.toBeNull()
    expect(evidence!.hold.releaseVersion).toBe('5.6.0')
    expect(evidence!.hold.similarity).toBeCloseTo(0.8731)
    expect(evidence!.hold.createdAt).toBeInstanceOf(Date)
    expect(evidence!.hold.createdAt.toISOString()).toBe('2024-02-24T00:00:00.000Z')
    expect(evidence!.trustStatus).toBe('held')
    expect(evidence!.matchedArc?.label).toBe('takeover')
    // 'false' as a JSON string must not become a truthy boolean — that would report an advisory
    // as already sent when it is still queued.
    expect(evidence!.advisories[0]!.sent).toBe(false)
    expect(evidence!.auditTrail[0]!.detail).toBeNull()
  })

  it('returns null for an unknown hold instead of an empty shell', async () => {
    const empty: SqlReader = { ...mcpShaped, async select() { return [] } }
    expect(await holdEvidence(HOLD_ID, empty)).toBeNull()
  })

  it('drives exactly five statements — one per read-only tool call', async () => {
    const seen: string[] = []
    const counting: SqlReader = {
      ...mcpShaped,
      async select<T>(sql: string): Promise<T[]> {
        seen.push(sql)
        return mcpShaped.select<T>(sql)
      },
    }
    await holdEvidence(HOLD_ID, counting)
    expect(seen).toHaveLength(5)
    for (const sql of seen) expect(() => assertSingleStatement(sql)).not.toThrow()
  })
})
