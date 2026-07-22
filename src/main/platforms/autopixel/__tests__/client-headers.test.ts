import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetHostLimiterForTests } from '../../../services/rate-limiter'

const { mainFetch } = vi.hoisted(() => ({ mainFetch: vi.fn() }))

vi.mock('../../../utils/main-fetch', async () => {
  const actual = await vi.importActual<typeof import('../../../utils/main-fetch')>(
    '../../../utils/main-fetch'
  )
  return { ...actual, mainFetch }
})

import { AutopixelClient } from '../client'

const ref = {
  host: 'autopixel.example.test',
  slug: 'blackcat',
  baseUrl: 'https://autopixel.example.test',
  shopPageUrl: 'https://autopixel.example.test/blackcat',
  token: 'autopixel.example.test/blackcat'
}

describe('AutopixelClient request metadata', () => {
  beforeEach(() => {
    mainFetch.mockReset()
    resetHostLimiterForTests()
  })

  it('uses document navigation and script subresource headers while discovering the action', async () => {
    const actionId = 'a'.repeat(40)
    mainFetch
      .mockResolvedValueOnce(
        new Response(
          '<html><script src="/_next/static/chunks/app.js"></script></html>',
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(`(${JSON.stringify(actionId)},"fetchWholesaleProductsAction")`, { status: 200 }))

    const client = new AutopixelClient(ref, { minIntervalMs: 0 })
    await expect(client.discoverWholesaleActionId()).resolves.toBe(actionId)

    const pageHeaders = mainFetch.mock.calls[0]![1].headers as Record<string, string>
    expect(pageHeaders.Accept).toContain('text/html')
    expect(pageHeaders['Sec-Fetch-Dest']).toBe('document')
    expect(pageHeaders['Sec-Fetch-Mode']).toBe('navigate')
    expect(pageHeaders['Sec-Fetch-Site']).toBe('none')

    const chunkHeaders = mainFetch.mock.calls[1]![1].headers as Record<string, string>
    expect(chunkHeaders.Accept).toBe('*/*')
    expect(chunkHeaders.Referer).toBe(ref.shopPageUrl)
    expect(chunkHeaders['Sec-Fetch-Dest']).toBe('script')
    expect(chunkHeaders['Sec-Fetch-Mode']).toBe('no-cors')
    expect(chunkHeaders['Sec-Fetch-Site']).toBe('same-origin')
  })

  it('uses same-origin Server Action metadata for the wholesale POST', async () => {
    const actionId = 'b'.repeat(40)
    mainFetch.mockResolvedValueOnce(new Response('1:{"success":true,"data":[]}', { status: 200 }))

    const client = new AutopixelClient(ref, { minIntervalMs: 0 })
    await expect(client.fetchWholesaleProducts(actionId)).resolves.toEqual([])

    const init = mainFetch.mock.calls[0]![1]
    const headers = init.headers as Record<string, string>
    expect(init.method).toBe('POST')
    expect(init.body).toBe('[]')
    expect(headers.Accept).toBe('text/x-component')
    expect(headers['Content-Type']).toBe('text/plain;charset=UTF-8')
    expect(headers['Next-Action']).toBe(actionId)
    expect(headers.Origin).toBe(ref.baseUrl)
    expect(headers.Referer).toBe(ref.shopPageUrl)
    expect(headers['Sec-Fetch-Dest']).toBe('empty')
    expect(headers['Sec-Fetch-Site']).toBe('same-origin')
  })
})
