/**
 * Branch-coverage pins for `src/mcp.ts`.
 *
 * `tests/mcp.test.ts` already exercises the load-bearing behaviour of this file end to end
 * (statement hygiene, the redaction state machine, request shaping, result parsing, the
 * fallback decision). This file exists only to close the specific cold branches that survey
 * left behind — each test below names the exact branch it pins and why it was cold, rather than
 * re-covering ground `mcp.test.ts` already owns.
 *
 * Same rules as `mcp.test.ts`: no network, no credentials, the fake-transport pattern
 * (`clientFactory` injection) for anything that would otherwise dial a server.
 */
import { describe, expect, it } from 'vitest'
import {
  CockroachMcpClient,
  MCP_TOOLS,
  McpResultError,
  parseRows,
  renderContent,
  resolveSqlReader,
  shapeArguments,
  type McpCallResult,
  type McpLike,
  type McpToolDef,
  type SqlReader,
} from '../src/mcp.js'

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
    async close() {},
  }
  return { client, sent }
}

async function connected(options?: Parameters<typeof fakeServer>[0]) {
  const server = fakeServer(options)
  const client = new CockroachMcpClient({ clientFactory: async () => server.client }, 'test')
  await client.connect()
  return { client, server }
}

describe('shapeArguments — schema shapes the alias table has never seen', () => {
  // A server can publish a `tools/list` entry whose `inputSchema` omits `properties` and
  // `required` outright (both are optional on `McpToolDef`) rather than declaring them empty.
  // `declared.length === 0` is meant to cover both cases identically — an absent schema is an
  // open one, same as an empty one — so this pins the `?? {}` and `?? []` fallbacks that make
  // that true instead of throwing on a server that just didn't bother declaring anything.
  it('treats a schema with no `properties` or `required` keys as a fully open one', () => {
    const bareTool: McpToolDef = { name: 'bare', inputSchema: { type: 'object' } }
    expect(shapeArguments(bareTool, { sql: 'SELECT 1' })).toEqual({ sql: 'SELECT 1' })
  })

  // `ARG_ALIASES` only knows five logical names. Anything else is meant to pass through under
  // its own name rather than being dropped — the whole point of shaping against the live schema
  // instead of a hardcoded list is that a server's own argument name always wins.
  it('passes a logical key with no configured alias through under its own name', () => {
    const tool = toolDef('t', { foo: {} })
    expect(shapeArguments(tool, { foo: 'bar' })).toEqual({ foo: 'bar' })
  })

  // The "no match" throw and the "missing required" throw both end in
  // `declared.join(', ') || '(none)'`. Every existing test that hits either throw does so
  // against a tool that DOES declare some properties, so the message names them and the
  // `(none)` fallback never fires. This is the natural way to reach it for the "required"
  // throw: a tool that requires an argument while declaring no properties at all — a
  // self-contradictory schema, but one this client has to survive since it does not control
  // what a server publishes.
  it('says "(none)" when a required argument is unmet and the server declares no properties', () => {
    const tool: McpToolDef = { name: 'strict', inputSchema: { type: 'object', properties: {}, required: ['x'] } }
    expect(() => shapeArguments(tool, {})).toThrow(/requires x, which this client did not supply\. Server declares: \(none\)\./)
  })

  // The mirror case for the OTHER throw ("declares no argument matching") is harder to reach
  // honestly: when `declared.length === 0` the code deliberately falls back to the caller's
  // canonical name unconditionally (see the comment on `shapeArguments`) rather than checking
  // whether that name is declared — so `!match` can only be true there if the canonical name
  // itself is falsy. Every real logical name this client uses ('sql', 'table', 'database',
  // 'schema', 'clusterId') is a non-empty string, so this is provably unreachable through any
  // call this codebase makes. It is NOT unreachable through the exported function itself,
  // though — `shapeArguments` takes an arbitrary `Record<string, ...>`, and a caller passing an
  // empty-string key is exactly the degenerate input that would trigger it. Per the coverage
  // rule ("hard to test is not a justification"), this pins that even a pathological empty key
  // gets a real, readable error rather than a silent pass or a different crash.
  it('says "(none)" for a pathological empty-string key against an open schema', () => {
    const tool: McpToolDef = { name: 'open', inputSchema: { type: 'object' } }
    expect(() => shapeArguments(tool, { '': 'x' })).toThrow(/declares no argument matching ""/)
    expect(() => shapeArguments(tool, { '': 'x' })).toThrow(/Server declares: \(none\)/)
  })
})

describe('renderContent — payload shapes with nothing readable in them', () => {
  // `result.content ?? []` — every other test always supplies `content`. A result missing the
  // field entirely (not merely empty) is still a legal `McpCallResult` per the type, and must
  // render as empty text rather than throwing on `undefined.filter`.
  it('renders empty text rather than throwing when `content` is absent altogether', () => {
    expect(renderContent({}, 'select_query')).toBe('')
  })

  // `text || '(no message)'` inside the isError throw. Every existing isError test supplies a
  // real message. A flagged error with no text blocks at all — or none of type 'text' — must
  // still produce a readable thrown message instead of "MCP tool x returned an error: ".
  it('says "(no message)" for a flagged error with no readable text', () => {
    expect(() => renderContent({ isError: true }, 'select_query')).toThrow(/\(no message\)/)
    expect(() => renderContent({ isError: true, content: [] }, 'select_query')).toThrow(/\(no message\)/)
  })
})

describe('parseRows — the two branches inside errorShapeMessage, and the NDJSON dead end', () => {
  // `truncate` only actually cuts when `text.length > max`. Every existing error-shape fixture
  // is short enough that the untruncated branch always wins — the truncation itself has never
  // fired. A distro packager IS going to see a multi-hundred-char permission error from a real
  // server eventually, and the whole point of `truncate` is that this message stays readable
  // instead of dumping a full multi-KB blob into a thrown error.
  it('truncates a long unflagged error payload instead of dumping the whole blob', () => {
    const bigMessage = 'x'.repeat(500)
    const payload = JSON.stringify({ error: bigMessage })
    let caught: Error | undefined
    try {
      parseRows(payload)
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeInstanceOf(McpResultError)
    expect(caught!.message).toContain('… (')
    expect(caught!.message).toContain(`${payload.length} chars total)`)
    // The embedded payload is the truncate()-cut copy, not the full ~500-char blob.
    const embedded = caught!.message.split('Full payload: ')[1]!
    expect(embedded.length).toBeLessThan(payload.length)
  })

  // `errorShapeMessage` checks `typeof value === 'string'` first and returns immediately when
  // it matches, which is every existing fixture. A server can just as plausibly nest a
  // structured error object under one of the `ERROR_KEYS` (`{"error": {"code": ..., ...}}`) —
  // that skips the string branch and must fall into `JSON.stringify(value)` rather than being
  // silently dropped as "not an error after all".
  it('stringifies an object-shaped error value rather than discarding it', () => {
    const payload = JSON.stringify({ error: { code: 42501, detail: 'permission denied for table' } })
    expect(() => parseRows(payload)).toThrow(McpResultError)
    expect(() => parseRows(payload)).toThrow(/"code":42501/)
  })

  // The NDJSON fallback's own final line — `if (ndjson.length) return ...; return { rows: [],
  // format: 'unparsed' }` — is only reached via the `return` inside the per-line `catch`
  // (a line that fails to parse at all) in every existing test. Text whose lines each parse
  // fine as JSON but never as an *object* (bare numbers here) walks the whole loop without
  // throwing and without ever pushing a row, which is the other way to end up with nothing:
  // the loop finishes, `ndjson.length` is 0, and the fallback below the loop is what answers.
  it('reports unparsed when every line parses cleanly but never to an object', () => {
    expect(parseRows('1\n2\n3')).toEqual({ rows: [], format: 'unparsed' })
  })
})

describe('CockroachMcpClient — connect(), close() and requireTool() edge shapes', () => {
  // `if (this.client) return [...this.toolIndex.values()]` — every existing test calls
  // connect() exactly once. Nothing pins that a second connect() is a safe, cheap no-op rather
  // than re-dialling and re-fetching tools/list a second time.
  it('returns the cached tool list on a second connect() without re-listing tools', async () => {
    const { client } = await connected()
    const before = [...client.calls]
    const second = await client.connect()
    expect(second.map((t) => t.name).sort()).toEqual(SERVER_TOOLS.map((t) => t.name).sort())
    expect(client.calls).toEqual(before) // no second 'tools/list'
  })

  // `this.availableTools().join(', ') || '(none)'` inside requireTool's error. Every existing
  // "tool not advertised" test connects to a session that has SOME tools, just not the one
  // asked for, so the message always names at least one. A session advertising literally
  // nothing must still say "(none)" rather than "Available: ".
  it('says "Available: (none)" when the session advertises no tools whatsoever', async () => {
    const { client } = await connected({ tools: [] })
    await expect(client.explain('SELECT 1 LIMIT 1')).rejects.toThrow(/Available: \(none\)/)
  })

  // `await this.client?.close()` has two arms and neither was pinned before this file: no
  // existing test calls `.close()` at all. This is the null arm — closing a client that was
  // never connected must not throw on `null?.close()`.
  it('closes cleanly even when connect() was never called', async () => {
    const client = new CockroachMcpClient({ clientFactory: async () => fakeServer().client })
    await expect(client.close()).resolves.toBeUndefined()
  })

  // The other arm of the same optional chain: a connected client's `.close()` must actually
  // reach the underlying transport's `close()`, and leave the client back in the "not
  // connected" state so a subsequent call correctly reports "connect() has not been called"
  // rather than reusing a torn-down transport.
  it('actually closes the underlying transport for a connected client', async () => {
    const { client, server } = await connected()
    let closed = false
    const original = server.client.close.bind(server.client)
    server.client.close = async () => {
      closed = true
      await original()
    }
    await client.close()
    expect(closed).toBe(true)
    await expect(client.select('SELECT 1 LIMIT 1')).rejects.toThrow(/connect\(\) has not been called/)
  })

  // `call()` recomputes `declared` from the tool schema independently of `shapeArguments` (see
  // the comment above it — this is the database-injection check, and it needs the property
  // list before shapeArguments runs). Same gap as the shapeArguments test above, but this is
  // the OTHER `?? {}` on the same fallback, reached only through a real tool call.
  it('drives a real call through a tool schema that omits `properties` entirely', async () => {
    const bareTool: McpToolDef = { name: 'bare_tool', inputSchema: { type: 'object' } }
    const { client, server } = await connected({
      tools: [bareTool],
      respond: () => ({ content: [{ type: 'text', text: 'ok' }] }),
    })
    expect(await client.call('bare_tool', { sql: 'SELECT 1' })).toBe('ok')
    expect(server.sent[0]!.args).toEqual({ sql: 'SELECT 1' })
  })

  // `show()`'s trailing `...(database ? { database } : {})` — every existing show() test omits
  // the database argument, so only the empty-spread arm has ever run. This is the other arm:
  // show() given a database, against a tool that actually declares one (SERVER_TOOLS' show tool
  // does not, on purpose, to keep the CockroachDB "usually optional" case as the default).
  it('includes the database in a show() call when one is passed and the tool declares it', async () => {
    const { client, server } = await connected({
      tools: [toolDef(MCP_TOOLS.show, { sql: {}, database: {} }, ['sql'])],
      respond: () => ({ content: [{ type: 'text', text: 'sleeper' }] }),
    })
    await client.show('SHOW DATABASE', 'sleeper')
    expect(server.sent[0]!.args).toEqual({ sql: 'SHOW DATABASE', database: 'sleeper' })
  })
})

describe('defaultClientFactory — the one path this file never dials for real', () => {
  // connect()'s `this.options.clientFactory ? … : await defaultClientFactory(this.options)` has
  // an alternate arm that every OTHER test in this suite deliberately avoids, by always
  // injecting `clientFactory`. That arm has to be exercised by SOMETHING, and the one part of
  // `defaultClientFactory` reachable without a live server or a mocked SDK module is its very
  // first guard: no API key, no dial attempted. This is not a network call — it throws before
  // constructing a transport or a client.
  it('refuses to dial when no API key is configured, without attempting a connection', async () => {
    const client = new CockroachMcpClient({ endpoint: 'https://example.invalid/mcp' })
    const saved = process.env.COCKROACH_MCP_API_KEY
    delete process.env.COCKROACH_MCP_API_KEY
    try {
      await expect(client.connect()).rejects.toThrow(/COCKROACH_MCP_API_KEY is not set/)
    } finally {
      if (saved !== undefined) process.env.COCKROACH_MCP_API_KEY = saved
    }
  })
})

describe('resolveSqlReader — a connect failure that is not an Error instance', () => {
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

  // `err instanceof Error ? err.message : String(err)` — the existing fallback test throws a
  // real `Error`. A `clientFactory` can reject with anything (a bare string, a plain object);
  // the reason string handed to the caller must still be readable rather than "[object Object]"
  // or a thrown-inside-the-catch crash.
  it('stringifies a non-Error rejection instead of assuming .message exists', async () => {
    const reader = await resolveSqlReader(directReader, { COCKROACH_MCP_API_KEY: 'sk' }, async () => {
      throw 'socket hang up' // eslint-disable-line no-throw-literal
    })
    expect(reader.via).toBe('direct')
    expect(reader.reason).toContain('socket hang up')
    expect(reader.reason).toContain('fell back to direct SQL')
  })
})
