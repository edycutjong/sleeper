/**
 * Structured logging — one JSON object per line, on stderr.
 *
 * stderr rather than stdout because stdout is where the demo scripts print their human-readable
 * banners and tables; keeping the machine-readable stream separate means `npm run replay >out.txt`
 * still shows a judge a readable transcript while `2>log.jsonl | jq` gives an operator the
 * timeline. JSON lines rather than a logging library because a release gate that a distro packager
 * is meant to audit should have zero dependencies between the decision and the record of it.
 *
 * Every line carries `corrId`: one id minted per replay / per Lambda invocation, so the six events
 * that make up a single decision (`ingest.written` → `arc.built` → `retrieval.explained` →
 * `decision.made` → `hold.committed`) can be pulled out of an interleaved log with one grep.
 *
 * What this is NOT: a metrics system. `durMs` on these lines is wall clock measured at the call
 * site and includes model and network time; it is enough to see which stage is slow at 3am, not
 * enough to bill anyone.
 */
import { randomUUID } from 'node:crypto'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogFields = Record<string, unknown>
export type LogLine = { ts: string; level: LogLevel; event: string } & LogFields

/** Where lines go. Swapped by the test suite; there is no other reason to touch it. */
let sink: (line: LogLine) => void = (line) => {
  process.stderr.write(`${JSON.stringify(line)}\n`)
}

/** Returns the previous sink so a test can restore it. `SLEEPER_LOG=off` silences everything. */
export function setLogSink(next: (line: LogLine) => void): (line: LogLine) => void {
  const previous = sink
  sink = next
  return previous
}

/** Short enough to read off a terminal, long enough not to collide within a demo. */
export function newCorrId(): string {
  return randomUUID().slice(0, 8)
}

export function emit(level: LogLevel, event: string, fields: LogFields = {}): void {
  if (process.env.SLEEPER_LOG === 'off') return
  // Undefined fields are dropped rather than serialised as `"x":null`, so an absent value and a
  // genuinely null one stay distinguishable in the log.
  const line: LogLine = { ts: new Date().toISOString(), level, event }
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) line[k] = v
  sink(line)
}

/**
 * Records a failure in full server-side and returns a reference the caller can safely hand out.
 *
 * The reason this exists rather than `return err.message`: the messages that reach here are mostly
 * pg's, and pg says things like
 * `connection to server at "sleeper-cluster-1234.gcp-europe-west1.cockroachlabs.cloud" (34.x.x.x),
 * port 26257 failed: FATAL: password authentication failed for user "sleeper_agent"` — cluster
 * hostname, IP, port and SQL user, all to whoever poked the endpoint. The operator needs that
 * string; the caller needs to be able to quote an incident. `ref` bridges the two: it is in the log
 * line and in the response, and it carries no information on its own.
 */
export function recordFailure(event: string, err: unknown, fields: LogFields = {}): string {
  const ref = newCorrId()
  emit('error', event, {
    ...fields,
    ref,
    errorName: err instanceof Error ? err.name : typeof err,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  })
  return ref
}

/** A logger with fields (corrId, packageId, …) bound, so call sites only name what is new. */
export type Logger = {
  readonly corrId: string
  child(fields: LogFields): Logger
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, fields?: LogFields): void
}

export function createLogger(bound: LogFields = {}): Logger {
  const corrId = typeof bound.corrId === 'string' ? bound.corrId : newCorrId()
  const base = { ...bound, corrId }
  const at =
    (level: LogLevel) =>
    (event: string, fields: LogFields = {}): void =>
      emit(level, event, { ...base, ...fields })
  return {
    corrId,
    child: (fields) => createLogger({ ...base, ...fields }),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  }
}
