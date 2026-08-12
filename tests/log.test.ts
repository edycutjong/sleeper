import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger, emit, newCorrId, recordFailure, setLogSink, type LogLine } from '../src/log.js'

// `setLogSink` returns whatever sink was active at the moment it is called. The very first call in
// this file — before any test has had a chance to swap it — is guaranteed to hand back the REAL
// default sink (stderr + JSON.stringify), because vitest gives each test file its own module
// registry. Capturing it here lets later tests restore the true default on demand instead of
// hardcoding a second copy of its logic.
let captured: LogLine[] = []
const testSink = (line: LogLine) => captured.push(line)
const realDefaultSink = setLogSink(testSink)

beforeEach(() => {
  captured = []
  setLogSink(testSink)
})

afterAll(() => {
  setLogSink(realDefaultSink)
})

describe('emit', () => {
  it('writes exactly one line per event, carrying ts/level/event plus the given fields', () => {
    emit('warn', 'ingest.written', { packageId: 'xz-utils', durMs: 12 })
    expect(captured).toHaveLength(1)
    const line = captured[0]!
    expect(line.level).toBe('warn')
    expect(line.event).toBe('ingest.written')
    expect(line.packageId).toBe('xz-utils')
    expect(line.durMs).toBe(12)
    // ts must be a real, round-trippable ISO timestamp — an operator greps/sorts on this field.
    expect(new Date(line.ts).toISOString()).toBe(line.ts)
  })

  it('drops fields whose value is undefined but keeps an explicit null', () => {
    // This is the whole point of the loop in emit(): `JSON.stringify` would already drop
    // `undefined` values on its own, so the only thing worth pinning here is that `null` — a
    // deliberately-recorded absence — survives where a merely-unset field does not.
    emit('info', 'e', { a: undefined, b: null, c: 0 })
    const line = captured[0]!
    expect('a' in line).toBe(false)
    expect(line.b).toBeNull()
    expect(line.c).toBe(0)
  })

  it('SLEEPER_LOG=off silences emit even with a hand-installed sink', () => {
    const prior = process.env.SLEEPER_LOG
    process.env.SLEEPER_LOG = 'off'
    try {
      emit('error', 'should.not.appear')
    } finally {
      // Restored unconditionally so this mutation cannot leak into a sibling test.
      if (prior === undefined) delete process.env.SLEEPER_LOG
      else process.env.SLEEPER_LOG = prior
    }
    expect(captured).toHaveLength(0)
  })

  it('emits normally again once SLEEPER_LOG stops being exactly "off"', () => {
    const prior = process.env.SLEEPER_LOG
    process.env.SLEEPER_LOG = 'verbose'
    try {
      emit('info', 'still.here')
    } finally {
      if (prior === undefined) delete process.env.SLEEPER_LOG
      else process.env.SLEEPER_LOG = prior
    }
    expect(captured).toHaveLength(1)
  })
})

describe('the default sink', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes JSON to stderr, and silently omits a value JSON cannot represent instead of throwing', () => {
    setLogSink(realDefaultSink)
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    // A function and a Symbol cannot be represented in JSON. `JSON.stringify` handles that by
    // *omitting* the property rather than throwing — which is the one thing standing between an
    // odd field value and taking the whole process down from inside a logging call. This pins
    // that guarantee against the REAL sink (not a test double), since a test sink swapped in by
    // `setLogSink` would sidestep `JSON.stringify` entirely and prove nothing about it.
    expect(() =>
      emit('info', 'weird.value', { cb: () => {}, tag: Symbol('x'), n: 1 }),
    ).not.toThrow()
    expect(writeSpy).toHaveBeenCalledTimes(1)
    const written = writeSpy.mock.calls[0]![0] as string
    expect(written.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(written)
    expect(parsed.n).toBe(1)
    expect('cb' in parsed).toBe(false)
    expect('tag' in parsed).toBe(false)
  })
})

describe('newCorrId', () => {
  it('mints an 8-character lowercase-hex id, short enough to read off a terminal', () => {
    expect(newCorrId()).toMatch(/^[0-9a-f]{8}$/)
  })

  it('is different on every call, so concurrent replays do not collide in the log', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newCorrId()))
    expect(ids.size).toBe(50)
  })
})

describe('recordFailure', () => {
  it('keeps the failure detail server-side and returns only a short, unrelated reference', () => {
    // The docstring on recordFailure exists precisely because pg error messages leak cluster
    // hostname/IP/port/user. This is the behaviour that guarantees that string never reaches a
    // caller: the RETURNED value must be nothing but the ref, even though the LOGGED line carries
    // the full message.
    const err = new Error(
      'connection to server at "sleeper-cluster-1234.gcp-europe-west1.cockroachlabs.cloud" (34.1.2.3), ' +
        'port 26257 failed: FATAL: password authentication failed for user "sleeper_agent"',
    )
    const ref = recordFailure('db.connect.failed', err, { attempt: 2 })

    expect(ref).toMatch(/^[0-9a-f]{8}$/)
    expect(ref).not.toContain('password')
    expect(ref).not.toContain('sleeper-cluster')

    expect(captured).toHaveLength(1)
    const line = captured[0]!
    expect(line.level).toBe('error')
    expect(line.event).toBe('db.connect.failed')
    expect(line.ref).toBe(ref) // the log line and the returned ref must be the SAME id
    expect(line.attempt).toBe(2)
    expect(line.errorName).toBe('Error')
    expect(line.message).toContain('password authentication failed')
    expect(typeof line.stack).toBe('string')
  })

  it('records a non-Error thrown value by its type and String() form, with no stack to invent', () => {
    // Something can be `throw`n that is not an Error (a string, a plain object from a library that
    // doesn't use the Error hierarchy). This is the ternary's other side: `err instanceof Error`
    // is false, so errorName/message fall back to typeof/String(), and `stack` — which does not
    // exist on a non-Error — must come out as `undefined` and therefore be DROPPED from the line
    // (see the emit() test above), not written as `"stack":null`.
    recordFailure('weird.failure', 'nope, not an Error')
    const line = captured[0]!
    expect(line.errorName).toBe('string')
    expect(line.message).toBe('nope, not an Error')
    expect('stack' in line).toBe(false)
  })

  it('stringifies a thrown object the same way String() would', () => {
    recordFailure('weirder.failure', { code: 'ECONNRESET' })
    const line = captured[0]!
    expect(line.errorName).toBe('object')
    expect(line.message).toBe(String({ code: 'ECONNRESET' }))
  })

  it('mints a fresh ref on every call, so two failures in one request stay distinguishable', () => {
    const a = recordFailure('e1', new Error('one'))
    const b = recordFailure('e2', new Error('two'))
    expect(a).not.toBe(b)
  })
})

describe('createLogger', () => {
  it('mints a fresh corrId when none is bound', () => {
    const logger = createLogger()
    expect(logger.corrId).toMatch(/^[0-9a-f]{8}$/)
  })

  it('reuses a bound corrId instead of minting a new one', () => {
    const logger = createLogger({ corrId: 'deadbeef' })
    expect(logger.corrId).toBe('deadbeef')
  })

  it('threads corrId and every other bound field onto each emitted line, at the right level', () => {
    const logger = createLogger({ corrId: 'deadbeef', packageId: 'xz-utils' })
    logger.info('ingest.written', { eventId: 'e1' })
    logger.warn('slow.stage')
    logger.error('hold.failed', { detail: 'x' })

    expect(captured).toHaveLength(3)
    for (const line of captured) {
      expect(line.corrId).toBe('deadbeef')
      expect(line.packageId).toBe('xz-utils')
    }
    expect(captured[0]!.level).toBe('info')
    expect(captured[0]!.eventId).toBe('e1')
    expect(captured[1]!.level).toBe('warn')
    expect(captured[2]!.level).toBe('error')
    expect(captured[2]!.detail).toBe('x')
  })

  it('call-site fields win over bound fields of the same name', () => {
    const logger = createLogger({ corrId: 'deadbeef', stage: 'ingest' })
    logger.info('e', { stage: 'decision' })
    expect(captured[0]!.stage).toBe('decision')
  })

  it('child() extends the bound fields for its own lines without mutating the parent logger', () => {
    const parent = createLogger({ corrId: 'deadbeef' })
    const child = parent.child({ actorId: 'jia-tan' })

    child.info('arc.built')
    parent.info('ingest.written')

    expect(captured[0]!.actorId).toBe('jia-tan')
    expect(captured[1]!.actorId).toBeUndefined() // the parent never learned about actorId
    expect(child.corrId).toBe('deadbeef') // corrId threads through child() unless overridden
  })

  it('child() can override corrId itself, producing a logger with its own id', () => {
    const parent = createLogger({ corrId: 'deadbeef' })
    const child = parent.child({ corrId: 'c0ffee00' })
    expect(child.corrId).toBe('c0ffee00')
    expect(parent.corrId).toBe('deadbeef') // parent unaffected
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The default sink must survive a field it cannot serialise.
//
// These were reported as a real gap rather than tested, because against the previous code they
// FAILED: `JSON.stringify` quietly drops a function or a Symbol, but it THROWS on a circular
// reference and on a BigInt — and this sink is the path `recordFailure` uses. Logging a circular
// field took the process down while it was in the middle of explaining a different error, so the
// diagnostic killed the thing it was diagnosing and the original error was never written.
//
// Each case imports a FRESH module so it gets the pristine default sink. `setLogSink` hands back
// the previous sink, not the original one, so once any earlier test has swapped it there is no way
// to restore the real default in-process — and asserting against a test double here would prove
// nothing, since the double is not the code that throws.
// ─────────────────────────────────────────────────────────────────────────────
describe('the default sink cannot be killed by its own payload', () => {
  async function emitOnFreshModule(fn: (m: typeof import('../src/log.js')) => void): Promise<string> {
    vi.resetModules()
    const fresh = await import('../src/log.js')
    const written: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      fn(fresh)
    } finally {
      process.stderr.write = original
    }
    return written.join('')
  }

  it('survives a circular reference and still names the event', async () => {
    const circular: Record<string, unknown> = { name: 'loop' }
    circular.self = circular
    const out = await emitOnFreshModule((m) => m.emit('error', 'sink.circular', { circular }))
    expect(out).toContain('sink.circular')
    // Degraded, not silent: the offending key is named so the gap is traceable.
    expect(out).toMatch(/\[circular\]|droppedKeys/)
  })

  it('survives a BigInt field and still names the event', async () => {
    const out = await emitOnFreshModule((m) => m.emit('error', 'sink.bigint', { size: 2n ** 70n }))
    expect(out).toContain('sink.bigint')
    expect(out).toMatch(/1180591620717411303424n|droppedKeys/)
  })
})
