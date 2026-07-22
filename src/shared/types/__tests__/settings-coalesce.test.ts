import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_SETTINGS, RECENT_SEARCHES_MAX } from '../../constants'
import { coalesceAppSettings, dualWriteSettingsPatch } from '../settings'

describe('coalesceAppSettings', () => {
  it('caps and trims recentSearches', () => {
    const long = Array.from({ length: RECENT_SEARCHES_MAX + 5 }, (_, i) => `  q${i}  `)
    const r = coalesceAppSettings(DEFAULT_APP_SETTINGS, { recentSearches: long })
    expect(r.recentSearches).toHaveLength(RECENT_SEARCHES_MAX)
    expect(r.recentSearches[0]).toBe('q0')
  })

  it('coalesces blockOnShopSyncFail as boolean', () => {
    expect(
      coalesceAppSettings(DEFAULT_APP_SETTINGS, { blockOnShopSyncFail: true }).blockOnShopSyncFail
    ).toBe(true)
    expect(
      coalesceAppSettings(DEFAULT_APP_SETTINGS, {
        // @ts-expect-error intentional corrupt payload
        blockOnShopSyncFail: 'true'
      }).blockOnShopSyncFail
    ).toBe(false)
  })

  it('coerces shop fresh threshold from minutes or legacy hours', () => {
    const fromHours = coalesceAppSettings(DEFAULT_APP_SETTINGS, { shopFreshHours: 2 })
    expect(fromHours.shopFreshMinutes).toBe(120)
    expect(fromHours.shopFreshHours).toBe(2)
    expect(fromHours.shopFreshUnit).toBe('hours')

    const fromMinutes = coalesceAppSettings(DEFAULT_APP_SETTINGS, {
      shopFreshMinutes: 45,
      shopFreshUnit: 'minutes'
    })
    expect(fromMinutes.shopFreshMinutes).toBe(45)
    expect(fromMinutes.shopFreshHours).toBe(0.75)
    expect(fromMinutes.shopFreshUnit).toBe('minutes')

    const clamped = coalesceAppSettings(DEFAULT_APP_SETTINGS, { shopFreshMinutes: 0 })
    expect(clamped.shopFreshMinutes).toBe(1)
  })

  it('keeps auto refresh opt-in and clamps its interval pair', () => {
    const defaults = coalesceAppSettings(DEFAULT_APP_SETTINGS, null)
    expect(defaults.autoRefreshEnabled).toBe(false)

    const enabled = coalesceAppSettings(DEFAULT_APP_SETTINGS, {
      autoRefreshEnabled: true,
      autoRefreshMinIntervalMs: 20 * 60_000,
      autoRefreshMaxIntervalMs: 5 * 60_000
    })
    expect(enabled.autoRefreshEnabled).toBe(true)
    expect(enabled.autoRefreshMinIntervalMs).toBe(20 * 60_000)
    expect(enabled.autoRefreshMaxIntervalMs).toBe(20 * 60_000)
  })

  it('forces shopScrapeEnabled to true', () => {
    const r = coalesceAppSettings(DEFAULT_APP_SETTINGS, {
      shopScrapeEnabled: false,
      ldxpScrapeEnabled: false
    })
    expect(r.shopScrapeEnabled).toBe(true)
    expect(r.ldxpScrapeEnabled).toBe(true)
  })

  it('rejects non-finite shopMinIntervalMs and dual-writes valid number', () => {
    const bad = coalesceAppSettings(DEFAULT_APP_SETTINGS, {
      // @ts-expect-error intentional corrupt payload
      shopMinIntervalMs: '500'
    })
    expect(bad.shopMinIntervalMs).toBe(DEFAULT_APP_SETTINGS.shopMinIntervalMs)

    const good = coalesceAppSettings(DEFAULT_APP_SETTINGS, { shopMinIntervalMs: 800 })
    expect(good.shopMinIntervalMs).toBe(800)
    expect(good.ldxpMinIntervalMs).toBe(800)
  })

  it('clamps shopMinIntervalMs to RATE_LIMITS min', () => {
    const r = coalesceAppSettings(DEFAULT_APP_SETTINGS, { shopMinIntervalMs: 1 })
    expect(r.shopMinIntervalMs).toBe(500)
  })

  it('forces shopPageConcurrency to 1', () => {
    expect(coalesceAppSettings(DEFAULT_APP_SETTINGS, { shopPageConcurrency: 0 }).shopPageConcurrency).toBe(
      1
    )
    expect(
      coalesceAppSettings(DEFAULT_APP_SETTINGS, { shopPageConcurrency: 99 }).shopPageConcurrency
    ).toBe(1)
    expect(
      coalesceAppSettings(DEFAULT_APP_SETTINGS, { shopPageConcurrency: 3.7 }).shopPageConcurrency
    ).toBe(1)
  })

  it('accepts theme modes and rejects invalid', () => {
    expect(coalesceAppSettings(DEFAULT_APP_SETTINGS, { theme: 'dark' }).theme).toBe('dark')
    expect(coalesceAppSettings(DEFAULT_APP_SETTINGS, { theme: 'light' }).theme).toBe('light')
    const bad = coalesceAppSettings(DEFAULT_APP_SETTINGS, {
      // @ts-expect-error intentional corrupt payload
      theme: 'auto'
    })
    expect(bad.theme).toBe('system')
  })
})

describe('dualWriteSettingsPatch', () => {
  it('forces shopScrapeEnabled true even when patch says false', () => {
    expect(dualWriteSettingsPatch({ shopScrapeEnabled: false })).toMatchObject({
      shopScrapeEnabled: true,
      ldxpScrapeEnabled: true
    })
  })

  it('dual-writes finite interval', () => {
    expect(dualWriteSettingsPatch({ shopMinIntervalMs: 900 })).toMatchObject({
      shopMinIntervalMs: 900,
      ldxpMinIntervalMs: 900
    })
  })

  it('caps recentSearches in patch', () => {
    const long = Array.from({ length: 20 }, (_, i) => `q${i}`)
    const p = dualWriteSettingsPatch({ recentSearches: long })
    expect(p.recentSearches).toHaveLength(RECENT_SEARCHES_MAX)
  })

  it('strips legacy proxy fields from coalesce', () => {
    const r = coalesceAppSettings(DEFAULT_APP_SETTINGS, {
      // @ts-expect-error legacy field from old settings JSON
      proxyCoreEnabled: true,
      // @ts-expect-error legacy field
      proxySubscriptions: [{ id: 'x', url: 'https://x.example', name: 'x', enabled: true }]
    })
    expect('proxyCoreEnabled' in r).toBe(false)
    expect('proxySubscriptions' in r).toBe(false)
  })
})
