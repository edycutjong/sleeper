/**
 * The demo server.
 *
 *   npm start        # http://localhost:3000
 *
 * Deliberately small: Node's own http module, no framework. It exposes the agent loop over
 * server-sent events so a judge can open one URL, press one button, and watch every write and
 * every vector search land in CockroachDB in real time. There is no login, no configuration
 * screen and no second scenario.
 *
 * The loop itself lives in src/agent.ts and is shared with `npm run replay` and the Lambda
 * handler — this file only transports it.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'
import { loadThresholds, loadTimeline } from './corpus.js'
import { OFFLINE, providerBanner } from './embeddings.js'
import { runReplay, type Step } from './agent.js'
import { explainScoped, holdEvidence, loadActorArc } from './memory.js'
import { closePool, query } from './db.js'

const here = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(here, '..', 'public')

/** One replay at a time: they all write to the same package's memory and would interleave. */
let replayInFlight = false

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function handleState(res: ServerResponse): Promise<void> {
  const { thresholds, calibrated } = loadThresholds()
  const [events, arcs, playbook, holds, trust] = await Promise.all([
    query<{ n: string }>('SELECT count(*) AS n FROM events'),
    query<{ n: string }>('SELECT count(*) AS n FROM actor_arcs'),
    query<{ n: string; held_out: boolean }>(
      'SELECT held_out, count(*) AS n FROM takeover_playbook GROUP BY held_out',
    ),
    query<{ id: string; release_version: string; created_at: Date }>(
      `SELECT id, release_version, created_at FROM release_hold
       WHERE package_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [config.packageId],
    ),
    query<{ status: string }>('SELECT status FROM trust_state WHERE package_id = $1', [
      config.packageId,
    ]),
  ])

  json(res, 200, {
    packageId: config.packageId,
    provider: providerBanner(),
    offline: OFFLINE,
    thresholds,
    calibrated,
    counts: {
      events: Number(events.rows[0]?.n ?? 0),
      arcs: Number(arcs.rows[0]?.n ?? 0),
      playbook: Number(playbook.rows.find((r) => !r.held_out)?.n ?? 0),
      heldOut: Number(playbook.rows.find((r) => r.held_out)?.n ?? 0),
    },
    trustStatus: trust.rows[0]?.status ?? null,
    latestHold: holds.rows[0]
      ? {
          id: holds.rows[0].id,
          releaseVersion: holds.rows[0].release_version,
          createdAt: holds.rows[0].created_at,
        }
      : null,
  })
}

async function handleReplay(res: ServerResponse): Promise<void> {
  if (replayInFlight) {
    json(res, 409, { error: 'A replay is already running. Wait for it to finish.' })
    return
  }
  replayInFlight = true

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })

  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  try {
    const timeline = loadTimeline(config.packageId)
    const { thresholds, calibrated } = loadThresholds()

    send('start', {
      packageId: timeline.packageId,
      total: timeline.events.length,
      actors: timeline.actors,
      provider: providerBanner(),
      offline: OFFLINE,
      thresholds,
      calibrated: Boolean(calibrated),
    })

    const summary = await runReplay(
      {
        packageId: timeline.packageId,
        suspectActor: config.suspectActor,
        windowDays: config.arcWindowDays,
        thresholds,
        events: timeline.events,
      },
      (step: Step) => {
        send(step.type, step)
      },
    )

    send('summary', summary)
  } catch (err) {
    // The stream is already open, so an error has to travel as an event rather than a status code.
    send('failed', { message: err instanceof Error ? err.message : String(err) })
  } finally {
    replayInFlight = false
    res.end()
  }
}

async function handleExplain(res: ServerResponse): Promise<void> {
  const arc = await loadActorArc(config.packageId, config.suspectActor)
  if (!arc) {
    json(res, 404, { error: 'No actor arc yet — run a replay first.' })
    return
  }
  json(res, 200, await explainScoped(config.packageId, arc.embedding))
}

async function handleHold(res: ServerResponse, holdId: string): Promise<void> {
  const evidence = await holdEvidence(holdId)
  if (!evidence) {
    json(res, 404, { error: `No release_hold with id ${holdId}` })
    return
  }
  json(res, 200, evidence)
}

function serveStatic(res: ServerResponse, file: string, type: string): void {
  try {
    const body = readFileSync(join(PUBLIC_DIR, file))
    res.writeHead(200, { 'content-type': type, 'content-length': body.length })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  }
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const route = url.pathname

  const run = async (): Promise<void> => {
    if (route === '/' || route === '/index.html') return serveStatic(res, 'index.html', 'text/html; charset=utf-8')
    if (route === '/app.css') return serveStatic(res, 'app.css', 'text/css; charset=utf-8')
    if (route === '/app.js') return serveStatic(res, 'app.js', 'text/javascript; charset=utf-8')
    if (route === '/icon.svg') return serveStatic(res, 'icon.svg', 'image/svg+xml')
    if (route === '/api/state') return handleState(res)
    if (route === '/api/replay') return handleReplay(res)
    if (route === '/api/explain') return handleExplain(res)
    if (route.startsWith('/api/hold/')) return handleHold(res, route.slice('/api/hold/'.length))
    json(res, 404, { error: 'not found' })
  }

  run().catch((err) => {
    console.error(err)
    if (!res.headersSent) json(res, 500, { error: err instanceof Error ? err.message : String(err) })
    else res.end()
  })
})

server.listen(config.port, () => {
  console.log(`Sleeper demo on http://localhost:${config.port}`)
  console.log(providerBanner())
  if (OFFLINE) {
    console.log('OFFLINE MODE — deterministic stand-in for Bedrock. Wiring only, no quality claims.')
  }
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      void closePool().finally(() => process.exit(0))
    })
  })
}
