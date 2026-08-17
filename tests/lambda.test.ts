/**
 * The Function URL is PUBLIC, so this file is mostly about what the entry point refuses.
 *
 * `ingestHandler` is mocked throughout: what is under test here is the routing and payload
 * decoding, and letting the real handler run would turn every case into an integration test that
 * needs a cluster to answer a question about a URL path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ingestHandler = vi.fn(async () => ({ statusCode: 200, headers: {}, body: '{"ok":true}' }))

vi.mock('../src/handler.js', () => ({ ingestHandler }))

const { handler } = await import('../src/lambda.js')

const req = (method: string, path: string, extra: Record<string, unknown> = {}) => ({
  requestContext: { http: { method, path } },
  ...extra,
})

beforeEach(() => {
  ingestHandler.mockClear()
})

describe('routing', () => {
  it('answers GET /health without touching the cluster', async () => {
    const res = await handler(req('GET', '/health'))
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
    expect(ingestHandler).not.toHaveBeenCalled()
  })

  it.each(['/', '/ingest'])('ingests on POST %s', async (path) => {
    const res = await handler(req('POST', path, { body: '{"actor_id":"a"}' }))
    expect(res.statusCode).toBe(200)
    expect(ingestHandler).toHaveBeenCalledWith({ actor_id: 'a' })
  })

  it('treats a trailing slash as the same route', async () => {
    await handler(req('POST', '/ingest/', { body: '{}' }))
    expect(ingestHandler).toHaveBeenCalledOnce()
  })

  it('falls back to rawPath when requestContext is absent', async () => {
    const res = await handler({ rawPath: '/health' } as never)
    // No requestContext means no method either, and the default is GET — so this is the health
    // route, not an ingest with a missing body.
    expect(res.statusCode).toBe(200)
  })

  it('defaults to / when there is no path at all', async () => {
    const res = await handler({} as never)
    expect(res.statusCode).toBe(404)
  })
})

describe('what it refuses', () => {
  // The reason this file exists. replayHandler resets and re-ingests the entire corpus; reachable
  // from an unauthenticated public URL, it is a wipe button for the memory the demo depends on.
  it('does not expose the replay path', async () => {
    const res = await handler(req('POST', '/replay', { body: '{}' }))
    expect(res.statusCode).toBe(404)
    expect(ingestHandler).not.toHaveBeenCalled()
  })

  it.each(['GET', 'PUT', 'DELETE', 'PATCH'])('refuses %s on the ingest route', async (method) => {
    const res = await handler(req(method, '/ingest', { body: '{}' }))
    expect(res.statusCode).toBe(404)
    expect(ingestHandler).not.toHaveBeenCalled()
  })

  it('names what IS allowed, so a 404 does not read as a broken deploy', async () => {
    const res = await handler(req('POST', '/nope', { body: '{}' }))
    expect(JSON.parse(res.body).allowed).toEqual(['POST /', 'POST /ingest', 'GET /health'])
  })

  it('answers malformed JSON with 400 rather than letting it surface as an internal error', async () => {
    const res = await handler(req('POST', '/', { body: '{oops' }))
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/not valid JSON/)
    expect(ingestHandler).not.toHaveBeenCalled()
  })
})

describe('body decoding', () => {
  it('base64-decodes when the Function URL says it did', async () => {
    const payload = { actor_id: 'jia-tan', kind: 'release' }
    await handler(
      req('POST', '/ingest', {
        isBase64Encoded: true,
        body: Buffer.from(JSON.stringify(payload)).toString('base64'),
      }),
    )
    expect(ingestHandler).toHaveBeenCalledWith(payload)
  })

  it('treats a missing body as an empty payload', async () => {
    await handler(req('POST', '/'))
    expect(ingestHandler).toHaveBeenCalledWith({})
  })

  it('ignores the base64 flag when there is no body to decode', async () => {
    await handler(req('POST', '/', { isBase64Encoded: true }))
    expect(ingestHandler).toHaveBeenCalledWith({})
  })
})
