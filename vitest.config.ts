import { defineConfig } from 'vitest/config'

/**
 * Coverage thresholds exist so 100% is a floor rather than a moment.
 *
 * Reaching full coverage once is easy to celebrate and easy to lose: the next feature lands with two
 * untested branches, the number reads 99.4%, nobody notices, and six weeks later it is back in the
 * eighties. The thresholds turn that into a failing build on the commit that caused it.
 *
 * A caveat worth stating plainly, because this project has already been bitten by it: 100% coverage
 * is not correctness. `src/decide.ts` sat at 100% lines and 97.6% branches while shipping a gate
 * whose abstain path never fired — every line ran, under a test that supplied a threshold production
 * never used. These numbers say "no line is unexamined". They do not say "the behaviour is right",
 * and a green report here is not evidence that it is.
 *
 * `src/server.ts` is excluded and that is deliberate, not an amnesty. Its route logic now lives in
 * its own module and IS measured; what remains is the bootstrap — a boot check, `listen`, and
 * shutdown — which the suite exercises by spawning the real process, so v8 cannot instrument it. The
 * two properties that matter there (GET /api/replay is unreachable, the process binds loopback only)
 * can only be established against a real listener. Including the file would mean either a permanent
 * red build or restructuring the entry point so it boots one way for tests and another for the demo.
 */
export default defineConfig({
  test: {
    /**
     * The suite runs offline by default, and that is a correctness requirement rather than a
     * convenience. `OFFLINE` is read once at module load in src/embeddings.ts, so a test that
     * asserts "this did not call Bedrock" is only meaningful if the flag was already set when
     * the module was first imported — setting it inside a test file is too late and silently
     * passes for the wrong reason. Setting it here also means a stray AWS credential in the
     * environment can never turn `npm test` into a billed run against real Bedrock.
     */
    env: {
      SLEEPER_OFFLINE: '1',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
})
