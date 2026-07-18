import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_SETTINGS } from '../../constants'
import { coalesceAppSettings } from '../settings'
import {
  activeProxySubscriptions,
  isAllowedProxySubscriptionUrl,
  normalizeProxySubscriptions,
  primaryProxySubscriptionUrl
} from '../proxy-subscription'

describe('proxy-subscription', () => {
  it('normalizes and caps subscriptions', () => {
    const r = normalizeProxySubscriptions([
      { id: 'a', url: ' https://x.com/1 ', name: ' A ', enabled: true },
      { id: 'a', url: 'https://x.com/2', name: 'dup id', enabled: false },
      { url: '', name: 'empty' },
      { id: 'b', url: 'https://x.com/3', enabled: true }
    ])
    expect(r).toHaveLength(3)
    expect(r[0]).toMatchObject({ id: 'a', url: 'https://x.com/1', name: 'A', enabled: true })
    expect(r[1].id).not.toBe('a')
    expect(r[2].id).toBe('b')
  })

  it('rejects non-http(s) subscription URLs', () => {
    expect(isAllowedProxySubscriptionUrl('https://ok.example/sub')).toBe(true)
    expect(isAllowedProxySubscriptionUrl('http://127.0.0.1:25500/sub')).toBe(true)
    expect(isAllowedProxySubscriptionUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedProxySubscriptionUrl('data:text/plain,hi')).toBe(false)
    expect(isAllowedProxySubscriptionUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedProxySubscriptionUrl('not-a-url')).toBe(false)
    expect(
      normalizeProxySubscriptions([
        { id: 'f', url: 'file:///tmp/x', name: 'bad', enabled: true },
        { id: 'ok', url: 'https://ok.example/s', name: 'good', enabled: true }
      ])
    ).toEqual([{ id: 'ok', url: 'https://ok.example/s', name: 'good', enabled: true }])
  })

  it('primary and active helpers', () => {
    const subs = normalizeProxySubscriptions([
      { id: '1', url: 'https://a', enabled: false, name: 'A' },
      { id: '2', url: 'https://b', enabled: true, name: 'B' }
    ])
    expect(primaryProxySubscriptionUrl(subs)).toBe('https://b')
    expect(activeProxySubscriptions(subs)).toHaveLength(1)
  })

  it('migrates legacy proxySubscriptionUrl into list', () => {
    const r = coalesceAppSettings(DEFAULT_APP_SETTINGS, {
      proxySubscriptionUrl: 'https://legacy.example/sub'
    })
    expect(r.proxySubscriptions).toHaveLength(1)
    expect(r.proxySubscriptions[0]?.url).toBe('https://legacy.example/sub')
    expect(r.proxySubscriptionUrl).toBe('https://legacy.example/sub')
  })

  it('dual-writes primary url from list', () => {
    const r = coalesceAppSettings(DEFAULT_APP_SETTINGS, {
      proxySubscriptions: [
        { id: 'x', url: 'https://one', name: '一', enabled: true },
        { id: 'y', url: 'https://two', name: '二', enabled: true }
      ]
    })
    expect(r.proxySubscriptionUrl).toBe('https://one')
    expect(r.proxyCallLogEnabled).toBe(false)
  })
})
