import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetHostLimiterForTests } from '../rate-limiter'

const { mainFetch } = vi.hoisted(() => ({ mainFetch: vi.fn() }))

vi.mock('../../utils/main-fetch', async () => {
  const actual = await vi.importActual<typeof import('../../utils/main-fetch')>('../../utils/main-fetch')
  return { ...actual, mainFetch }
})

import { HttpClient } from '../http-client'

describe('HttpClient retry policy', () => {
  beforeEach(() => {
    mainFetch.mockReset()
    resetHostLimiterForTests()
  })

  it('does not replay 429 responses', async () => {
    mainFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'slow down' }), {
        status: 429,
        headers: { 'retry-after': '60' }
      })
    )
    const client = new HttpClient({ minIntervalMs: 0, maxRetries: 2 })

    await expect(client.getJson('https://example.test/api')).rejects.toMatchObject({
      code: 'RATE_LIMIT',
      details: { retryAfterMs: 60_000 }
    })
    expect(mainFetch).toHaveBeenCalledTimes(1)
  })

  it('retries a transient transport failure once it is classified as retryable', async () => {
    mainFetch
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
    const client = new HttpClient({ minIntervalMs: 0, maxRetries: 1 })

    await expect(client.getJson('https://example.test/api')).resolves.toMatchObject({
      body: { ok: true }
    })
    expect(mainFetch).toHaveBeenCalledTimes(2)
  })

  it('does not retry permanent client errors or malformed JSON', async () => {
    mainFetch.mockResolvedValue(new Response('forbidden', { status: 403 }))
    const client = new HttpClient({ minIntervalMs: 0, maxRetries: 2 })
    await expect(client.getJson('https://example.test/api')).rejects.toMatchObject({
      code: 'NETWORK'
    })
    expect(mainFetch).toHaveBeenCalledTimes(1)

    mainFetch.mockReset()
    mainFetch.mockResolvedValue(new Response('<html>challenge</html>', { status: 200 }))
    await expect(client.getJson('https://example.test/api')).rejects.toMatchObject({
      code: 'SCHEMA_VALIDATION'
    })
    expect(mainFetch).toHaveBeenCalledTimes(1)
  })
})
