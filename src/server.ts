/**
 * The demo server — bootstrap only.
 *
 *   npm start        # http://127.0.0.1:3000
 *
 * Deliberately small: Node's own http module, no framework. It exposes the agent loop over
 * server-sent events so a judge can open one URL, press one button, and watch every write and
 * every vector search land in CockroachDB in real time. There is no login, no configuration
 * screen and no second scenario.
 *
 * The loop itself lives in src/agent.ts and is shared with `npm run replay` and the Lambda
 * handler; the routes live in src/routes.ts. This file only decides *whether to come up* and then
 * transports: the corpus/model check, one `createServer`, one `listen`, the banner, and shutdown.
 *
 * Because there is no login, the server binds to loopback by default and the one destructive route
 * requires POST. See `resolveBindHost` here and the `/api/replay` method check in src/routes.ts —
 * this is a demo surface, not an authenticated API, and the boundary is the network, not a token.
 *
 * Importable without booting. Everything below is an exported function over injected collaborators,
 * and the only statement with a side effect is the entry-point guard at the bottom: `tsx
 * src/server.ts` boots, `import './server.js'` does not. That is the standard dual-purpose-module
 * idiom rather than a test flag — there is no branch here that behaves differently under test, and
 * the boot the demo actually performs is still exercised for real by the child process that
 * tests/server.test.ts spawns.
 */
import { createServer, type Server } from 'node:http'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'
import { OFFLINE, providerBanner } from './embeddings.js'
import { assertPlaybookModel } from './memory.js'
import { resolveMcpMode } from './mcp.js'
import { closePool } from './db.js'
import { emit, recordFailure } from './log.js'
import { createRouter, VERSION, type Router } from './routes.js'

/**
 * Loopback by default.
 *
 * The previous `server.listen(port)` bound every interface, which on a laptop on conference wifi
 * puts an unauthenticated route that wipes the demo's memory on the local network. Overridable
 * because a container has to bind 0.0.0.0 to be reachable at all — but that is now a decision
 * someone makes, with an env var, rather than the default.
 */
export function resolveBindHost(env: NodeJS.ProcessEnv): string {
  return env.SLEEPER_BIND_HOST ?? '127.0.0.1'
}

/**
 * What the terminal says on the way up.
 *
 * Returned as lines rather than printed, so the two conditional lines — the offline notice and the
 * non-loopback warning — are assertable without binding a test to a public interface. The warning
 * in particular is the one line here nobody wants to discover was silently dropped, and proving it
 * appears for 0.0.0.0 must not require actually listening on 0.0.0.0.
 */
export function bootBannerLines(input: {
  host: string
  port: number
  offline: boolean
  provider: string
}): string[] {
  const lines = [`Sleeper demo on http://${input.host}:${input.port}`, input.provider]
  if (input.offline) {
    lines.push('OFFLINE MODE — deterministic stand-in for Bedrock. Wiring only, no quality claims.')
  }
  if (input.host !== '127.0.0.1' && input.host !== 'localhost') {
    lines.push(
      `WARNING: bound to ${input.host}, not loopback. /api/replay resets this package's memory and ` +
        'there is no authentication on this server.',
    )
  }
  return lines
}

/**
 * The corpus/model check, run once at boot instead of at the moment a decision is due.
 *
 * `assertPlaybookModel` was exported so an entry point could call it and no entry point ever did:
 * its only caller was the empty-match path inside `matchPlaybook`. A process pointed at a corpus
 * embedded by a different model therefore started, reported health `ok`, and refused only once a
 * release was being assessed — mid-recording, in the demo's case. Its thrown message is a complete
 * operator instruction (re-seed, or point the process back at the model that wrote the corpus), so
 * a boot that dies printing it is worth more than a server that comes up unable to decide.
 *
 * A cluster that could not answer the query is not the same as a check that said no, and it does
 * not stop the boot. Unreachable-at-startup — or a table being recreated by a migration at that
 * instant — is exactly what `/api/health` exists to report as 503 and what `/api/state` degrades
 * for, and neither can report anything from a process that refused to listen.
 *
 * Discriminated on the message because there is no error class to test: memory.ts throws a plain
 * `Error`. If that message is ever reworded this stops being fatal at boot, which is the safe
 * direction to fail — the same check still runs on the empty-match path before any decision.
 *
 * Honest about the limit: this only fires when a corpus embedded by a DIFFERENT model exists. An
 * empty playbook passes silently, by design — so it is not a "did you run `npm run seed`?" check
 * and an untouched cluster will sail through it.
 */
export async function checkPlaybookModel(assert: () => Promise<void>): Promise<void> {
  try {
    await assert()
  } catch (err) {
    if (err instanceof Error && /embedding model mismatch/i.test(err.message)) throw err
    recordFailure('startup.playbook_model_uncheckable', err)
  }
}

/**
 * Is this module the process entry point?
 *
 * Compares real paths rather than URL strings: `tsx` normalises `argv[1]` to an absolute path but
 * not necessarily through the same symlinks as the resolved module URL (`/tmp` vs `/private/tmp` on
 * macOS is the everyday case), and a mismatch here would mean `npm start` silently not starting.
 * A path that cannot be resolved at all is not the entry point — nothing was started, so nothing is
 * broken by saying no.
 */
export function isEntryPoint(moduleUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(resolve(argv1))
  } catch {
    return false
  }
}

export type BootDeps = {
  router: Router
  host: string
  port: number
  offline: boolean
  providerBanner: () => string
  version: string
  assertPlaybookModel: () => Promise<void>
  closePool: () => Promise<void>
  /** Human-readable banner sink. stdout in production — see the comment in `boot`. */
  log: (line: string) => void
  /** `process.exit` in production; a spy under test, which is the only way to reach the last line. */
  exit: (code: number) => void
  /** Registers a shutdown signal handler. Injected so a test does not install one in the runner. */
  onSignal: (signal: NodeJS.Signals, handler: () => void) => void
}

export type BootedServer = {
  server: Server
  /** Idempotent enough for a signal handler: `server.close` on an already-closing server is a no-op. */
  shutdown: () => void
}

/** Production wiring — the one place the real collaborators are named. */
export function productionBootDeps(): BootDeps {
  return {
    router: createRouter(),
    host: resolveBindHost(process.env),
    port: config.port,
    offline: OFFLINE,
    providerBanner,
    version: VERSION,
    assertPlaybookModel,
    closePool,
    log: console.log,
    exit: process.exit,
    onSignal: (signal, handler) => {
      process.on(signal, handler)
    },
  }
}

/**
 * Runs the boot check, starts listening, and wires shutdown. Resolves once the socket is bound.
 *
 * The check runs BEFORE `listen`, deliberately: a process that cannot decide should not be
 * answering `/api/health` with `ok` while it fails every assessment.
 */
export async function boot(deps: BootDeps): Promise<BootedServer> {
  await checkPlaybookModel(deps.assertPlaybookModel)

  const server = createServer(deps.router.handle)

  const shutdown = (): void => {
    deps.router.shutdown()
    server.close(() => {
      void deps.closePool().finally(() => deps.exit(0))
    })
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) deps.onSignal(signal, shutdown)

  await new Promise<void>((settle) => {
    server.listen(deps.port, deps.host, () => {
      // stdout stays human: this banner is what a judge sees in the terminal during a recording. The
      // machine-readable stream is stderr — see src/log.ts.
      for (const line of bootBannerLines({
        host: deps.host,
        port: deps.port,
        offline: deps.offline,
        provider: deps.providerBanner(),
      })) {
        deps.log(line)
      }
      emit('info', 'server.listening', {
        host: deps.host,
        port: deps.port,
        version: deps.version,
        inference: deps.offline ? 'offline' : 'bedrock',
        mcp: resolveMcpMode().via,
      })
      settle()
    })
  })

  return { server, shutdown }
}

/**
 * The one side effect in this file, and the reason the rest of it is measurable.
 *
 * Unreachable from the test runner by construction, not by a flag: the condition is true exactly
 * when this module IS the process entry (`tsx src/server.ts`, `npm start`), and under vitest
 * `argv[1]` is the runner. Nothing is stubbed and nothing behaves differently — the boot the demo
 * performs is the boot the child process in tests/server.test.ts performs, which is what proves
 * `/api/replay` is unreachable by GET and that the bind is loopback-only. The three pieces this
 * line is made of are each covered directly: `isEntryPoint` (both answers and the unresolvable
 * path), `productionBootDeps` (every field, including the signal registration), and `boot` (a real
 * listener on an ephemeral port, banner, and shutdown through to `exit`).
 */
/* v8 ignore next 3 -- entry-point invocation; justified immediately above: true only when this file is the process entry, never under vitest. */
if (isEntryPoint(import.meta.url, process.argv[1])) {
  await boot(productionBootDeps())
}
