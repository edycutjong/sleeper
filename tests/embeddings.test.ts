import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * tests/unit.test.ts already exercises `offlineEmbed` itself — determinism, L2 normalisation,
 * empty input, related-vs-unrelated scoring. This file covers what that suite does not:
 * `offlineConverse` (reachable only through `converse()`), the `embed`/`converse`/`providerBanner`
 * wrappers themselves, and — the one branch no amount of calling the offline path exercises — the
 * real-Bedrock side of each of those three OFFLINE ternaries.
 *
 * `../src/bedrock.js` is mocked for this whole file rather than the AWS SDK it wraps: what's under
 * test here is that `embed`/`converse`/`providerBanner` DISPATCH to the right implementation, not
 * bedrock.ts's own retry/timeout behaviour (that belongs to tests/bedrock.test.ts, which this file
 * must not duplicate).
 */
const { mockBedrockEmbed, mockBedrockConverse } = vi.hoisted(() => ({
  mockBedrockEmbed: vi.fn(),
  mockBedrockConverse: vi.fn(),
}))

vi.mock('../src/bedrock.js', () => ({
  embed: mockBedrockEmbed,
  converse: mockBedrockConverse,
}))

import { OFFLINE, converse, embed, providerBanner } from '../src/embeddings.js'
import { config } from '../src/config.js'

afterEach(() => {
  mockBedrockEmbed.mockClear()
  mockBedrockConverse.mockClear()
})

describe('embeddings — offline stand-in (this suite runs under SLEEPER_OFFLINE=1)', () => {
  it('OFFLINE reflects the env var this whole measured run requires', () => {
    // If this is false, every assertion below about "does not call Bedrock" would be true for the
    // wrong reason — nothing would call Bedrock because nothing here is even offline.
    expect(OFFLINE).toBe(true)
  })

  it('embed() dispatches to the deterministic offline embedder, not Bedrock', async () => {
    const vector = await embed('the maintainer handed over release signing authority')
    expect(vector).toHaveLength(config.aws.embeddingDimensions)
    expect(vector.every(Number.isFinite)).toBe(true)
    expect(mockBedrockEmbed).not.toHaveBeenCalled()
  })

  it('converse() reconstructs a deterministic arc summary from the dashed lines in the prompt', async () => {
    const prompt = [
      'behavioural arc for jia-tan, xz-utils',
      '- became co-maintainer with commit access',
      '- pushed a change disabling a test that would have caught the backdoor',
      '- published release 5.6.0 containing the backdoor',
    ].join('\n')

    const out = await converse('system prompt (ignored offline)', prompt)

    expect(out).toContain('[OFFLINE STAND-IN — not model output]')
    // Exactly the 3 dashed lines, not the header — this is the count the real prompt-builder in
    // src/agent.ts relies on to say how much history the arc behind a decision was built from.
    expect(out).toContain('3 recorded events')
    expect(out).toContain('published release 5.6.0 containing the backdoor')
    expect(mockBedrockConverse).not.toHaveBeenCalled()
  })

  it('truncates a summary built from many long dashed lines to 4000 characters', async () => {
    // Only the first 5 and last 12 lines ever make it into the summary (see src/embeddings.ts), so
    // hitting the 4000-char cap needs those specific lines to be long, not merely numerous.
    const long = (i: number) => `- event ${i} ${'x'.repeat(280)}`
    const prompt = Array.from({ length: 20 }, (_, i) => long(i)).join('\n')

    const out = await converse('system', prompt)

    expect(out.length).toBe(4000)
  })

  it('providerBanner names the offline stand-in and disclaims any quality result', () => {
    expect(providerBanner()).toBe(
      'inference: OFFLINE deterministic stand-in (SLEEPER_OFFLINE=1) — wiring only, no quality claims',
    )
  })
})

/**
 * `OFFLINE` is a `const` computed once from `process.env.SLEEPER_OFFLINE` at module-evaluation
 * time (see src/embeddings.ts), so the only way to observe the real-Bedrock side of its three
 * ternaries is a fresh module instance imported under a controlled environment — the same
 * constraint and the same fix tests/config.test.ts uses for src/config.ts's env-derived fields.
 *
 * `dotenv/config` is mocked to a no-op for the controlled import for the same reason as there:
 * dotenv only fills a var that is entirely ABSENT from process.env, and leaving it live would let
 * it silently refill SLEEPER_OFFLINE out of a real `.env` before the module body runs (this
 * checkout's `.env` does not define it, but a future one could, and the test would then be
 * exercising `.env` contents instead of the code path).
 */
async function withOfflineUnset<T>(fn: (fresh: typeof import('../src/embeddings.js')) => Promise<T>): Promise<T> {
  const saved = process.env.SLEEPER_OFFLINE
  delete process.env.SLEEPER_OFFLINE
  vi.resetModules()
  vi.doMock('dotenv/config', () => ({}))
  try {
    const fresh = await import('../src/embeddings.js')
    return await fn(fresh)
  } finally {
    if (saved === undefined) delete process.env.SLEEPER_OFFLINE
    else process.env.SLEEPER_OFFLINE = saved
    vi.doUnmock('dotenv/config')
    vi.resetModules()
  }
}

describe('embeddings — real inference path (module re-imported with SLEEPER_OFFLINE unset)', () => {
  it('OFFLINE is false once the env var is unset', async () => {
    await withOfflineUnset(async (fresh) => {
      expect(fresh.OFFLINE).toBe(false)
    })
  })

  it('embed() delegates to Bedrock and returns exactly what it returns', async () => {
    mockBedrockEmbed.mockResolvedValueOnce([0.1, 0.2, 0.3])
    await withOfflineUnset(async (fresh) => {
      const result = await fresh.embed('some text')
      expect(result).toEqual([0.1, 0.2, 0.3])
      expect(mockBedrockEmbed).toHaveBeenCalledWith('some text')
    })
  })

  it('converse() delegates to Bedrock, defaulting maxTokens and forwarding a custom one', async () => {
    mockBedrockConverse.mockResolvedValue('bedrock says hi')
    await withOfflineUnset(async (fresh) => {
      await fresh.converse('sys', 'prompt')
      expect(mockBedrockConverse).toHaveBeenCalledWith('sys', 'prompt', 1024)

      await fresh.converse('sys', 'prompt', 256)
      expect(mockBedrockConverse).toHaveBeenLastCalledWith('sys', 'prompt', 256)
    })
  })

  it('providerBanner names AWS Bedrock and the configured model ids, not the offline stand-in', async () => {
    await withOfflineUnset(async (fresh) => {
      expect(fresh.providerBanner()).toBe(
        `inference: AWS Bedrock — ${config.aws.embeddingModelId} + ${config.aws.chatModelId}`,
      )
    })
  })
})
