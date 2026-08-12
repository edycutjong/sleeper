import { describe, expect, it, vi } from 'vitest'
import { config, MCP_DEFAULT_ENDPOINT } from '../src/config.js'

/**
 * Env vars every branch under test cares about. Listed explicitly (rather than snapshotting all
 * of `process.env`) so `withFreshConfig` below can delete exactly these before each controlled
 * re-import and restore exactly these afterward — nothing else in the environment is touched.
 */
const RELEVANT_KEYS = [
  'DATABASE_URL',
  'AWS_REGION',
  'BEDROCK_EMBEDDING_MODEL_ID',
  'BEDROCK_CHAT_MODEL_ID',
  'PACKAGE_ID',
  'ARC_WINDOW_DAYS',
] as const

/**
 * `config.aws.*`, `config.packageId` and `config.arcWindowDays` are not functions — they are
 * plain values read from `process.env` once, at module-evaluation time (see src/config.ts). That
 * is why they don't take an injectable `env` argument the way `databaseName`/`mcp.*` do, and it
 * means the only way to exercise BOTH the "unset -> default" and "set -> override" side of each
 * `??` is to import a fresh module instance under a controlled environment.
 *
 * Two wrinkles that make a naive `delete process.env.X; import()` wrong:
 *  1. This checkout has a real `.env`, and `src/config.ts` starts with `import 'dotenv/config'`.
 *     dotenv only fills a var that is entirely ABSENT from `process.env` — so deleting a var and
 *     re-importing would just let dotenv silently refill it from `.env` before the config object
 *     literal runs, and the "unset" branch would never actually be observed. Mocking
 *     `dotenv/config` to a no-op for the controlled import removes that interference.
 *  2. Whatever this touches must be fully restored afterward, and the restore must happen only
 *     AFTER the caller is done with the returned config (e.g. `config.databaseUrl()` reads
 *     `process.env` at CALL time, not at import time) — hence the callback shape rather than
 *     returning the config object directly.
 */
async function withFreshConfig<T>(
  overrides: Partial<Record<(typeof RELEVANT_KEYS)[number], string>>,
  fn: (freshConfig: typeof config) => T,
): Promise<T> {
  const saved: Partial<Record<string, string>> = {}
  for (const k of RELEVANT_KEYS) saved[k] = process.env[k]
  for (const k of RELEVANT_KEYS) delete process.env[k]
  Object.assign(process.env, overrides)

  vi.resetModules()
  vi.doMock('dotenv/config', () => ({}))
  try {
    const mod = await import('../src/config.js')
    return fn(mod.config)
  } finally {
    for (const k of RELEVANT_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    vi.doUnmock('dotenv/config')
    vi.resetModules()
  }
}

describe('config — static env-derived fields', () => {
  it('falls back to the documented defaults when nothing is set', async () => {
    await withFreshConfig({}, (c) => {
      expect(c.aws.region).toBe('us-east-1')
      expect(c.aws.embeddingModelId).toBe('amazon.titan-embed-text-v2:0')
      expect(c.aws.chatModelId).toBe('us.anthropic.claude-sonnet-4-5-20250929-v1:0')
      expect(c.packageId).toBe('xz-utils')
      expect(c.arcWindowDays).toBe(90)
    })
  })

  it('takes each override when its env var is set', async () => {
    await withFreshConfig(
      {
        AWS_REGION: 'eu-west-1',
        BEDROCK_EMBEDDING_MODEL_ID: 'custom-embed-model',
        BEDROCK_CHAT_MODEL_ID: 'custom-chat-model',
        PACKAGE_ID: 'left-pad',
        ARC_WINDOW_DAYS: '30',
      },
      (c) => {
        expect(c.aws.region).toBe('eu-west-1')
        expect(c.aws.embeddingModelId).toBe('custom-embed-model')
        expect(c.aws.chatModelId).toBe('custom-chat-model')
        expect(c.packageId).toBe('left-pad')
        expect(c.arcWindowDays).toBe(30)
      },
    )
  })

  it('lets a present-but-malformed ARC_WINDOW_DAYS through as NaN rather than the default', async () => {
    // `Number(x ?? 90)` only falls back to 90 when x is nullish. A var that IS set, just to
    // something non-numeric, skips the `??` entirely and goes straight to `Number('not-a-number')`
    // — which is NaN, not 90 and not a thrown error. Pinning the actual behaviour rather than the
    // friendlier one, so this stays honest about what a typo'd env var really does today.
    await withFreshConfig({ ARC_WINDOW_DAYS: 'not-a-number' }, (c) => {
      expect(Number.isNaN(c.arcWindowDays)).toBe(true)
    })
  })

  it('embeddingDimensions is a fixed constant, independent of env — matches VECTOR(1024) in schema', async () => {
    await withFreshConfig({}, (c) => {
      expect(c.aws.embeddingDimensions).toBe(1024)
    })
  })
})

describe('config.databaseUrl / required()', () => {
  it('throws a message naming the missing var when DATABASE_URL is unset', async () => {
    await withFreshConfig({}, (c) => {
      expect(() => c.databaseUrl()).toThrow(/Missing required env var DATABASE_URL/)
    })
  })

  it('returns the value once DATABASE_URL is set', async () => {
    await withFreshConfig({ DATABASE_URL: 'postgresql://root@host:26257/sleeper' }, (c) => {
      expect(c.databaseUrl()).toBe('postgresql://root@host:26257/sleeper')
    })
  })
})

describe('config.databaseName', () => {
  it('prefers SLEEPER_DATABASE even when DATABASE_URL names a different database', () => {
    const env = {
      SLEEPER_DATABASE: 'override_db',
      DATABASE_URL: 'postgresql://root@host:26257/other_db',
    } as NodeJS.ProcessEnv
    expect(config.databaseName(env)).toBe('override_db')
  })

  it('derives the name from the DATABASE_URL path when there is no override', () => {
    const env = { DATABASE_URL: 'postgresql://root@host:26257/sleeper?sslmode=disable' } as NodeJS.ProcessEnv
    expect(config.databaseName(env)).toBe('sleeper')
  })

  it('decodes a percent-encoded path segment', () => {
    const env = { DATABASE_URL: 'postgresql://root@host:26257/my%20db' } as NodeJS.ProcessEnv
    expect(config.databaseName(env)).toBe('my db')
  })

  it('returns null, not a throw, when neither SLEEPER_DATABASE nor DATABASE_URL is set', () => {
    expect(config.databaseName({} as NodeJS.ProcessEnv)).toBeNull()
  })

  it('returns null when the URL has no path segment to derive a name from', () => {
    const env = { DATABASE_URL: 'postgresql://root@host:26257' } as NodeJS.ProcessEnv
    expect(config.databaseName(env)).toBeNull()
  })

  it('returns null rather than throwing when DATABASE_URL cannot be parsed as a URL at all', () => {
    // This is the load-bearing case: an MCP-only checkout with a garbled DATABASE_URL must still
    // be able to dial the MCP server, so a parse failure here must degrade, never throw.
    const env = { DATABASE_URL: 'not a url' } as NodeJS.ProcessEnv
    expect(() => config.databaseName(env)).not.toThrow()
    expect(config.databaseName(env)).toBeNull()
  })

  it('falls back to process.env when called with no argument at all', () => {
    // Exercises the function's own default parameter (`env = process.env`) — every other test in
    // this suite passes an explicit env object per the "don't mutate process.env" rule, so this is
    // the one deliberate exception: it only asserts the call doesn't throw, never a specific
    // value, precisely so it stays independent of whatever the ambient environment happens to be.
    expect(() => config.databaseName()).not.toThrow()
  })
})

describe('config.mcp', () => {
  it('endpoint falls back to the documented default when COCKROACH_MCP_URL is unset', () => {
    expect(config.mcp.endpoint({} as NodeJS.ProcessEnv)).toBe(MCP_DEFAULT_ENDPOINT)
  })

  it('endpoint uses COCKROACH_MCP_URL when set', () => {
    const env = { COCKROACH_MCP_URL: 'https://example.test/mcp' } as NodeJS.ProcessEnv
    expect(config.mcp.endpoint(env)).toBe('https://example.test/mcp')
  })

  it('apiKey is null when unset, and the key when set', () => {
    expect(config.mcp.apiKey({} as NodeJS.ProcessEnv)).toBeNull()
    const env = { COCKROACH_MCP_API_KEY: 'secret-key' } as NodeJS.ProcessEnv
    expect(config.mcp.apiKey(env)).toBe('secret-key')
  })

  it('clusterId is null when unset, and the id when set', () => {
    expect(config.mcp.clusterId({} as NodeJS.ProcessEnv)).toBeNull()
    const env = { COCKROACH_CLUSTER_ID: 'cluster-1' } as NodeJS.ProcessEnv
    expect(config.mcp.clusterId(env)).toBe('cluster-1')
  })

  it('disabled is false unless SLEEPER_MCP is exactly "off"', () => {
    expect(config.mcp.disabled({} as NodeJS.ProcessEnv)).toBe(false)
    expect(config.mcp.disabled({ SLEEPER_MCP: 'true' } as NodeJS.ProcessEnv)).toBe(false)
    expect(config.mcp.disabled({ SLEEPER_MCP: 'off' } as NodeJS.ProcessEnv)).toBe(true)
  })
})
