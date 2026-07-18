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

  it('rejects non-boolean shopScrapeEnabled from dual keys', () => {
    const r = coalesceAppSettings(DEFAULT_APP_SETTINGS, {
      // @ts-expect-error intentional corrupt payload
      shopScrapeEnabled: 'false',
      // @ts-expect-error intentional corrupt payload
      ldxpScrapeEnabled: 'true'
    })
    expect(r.shopScrapeEnabled).toBe(DEFAULT_APP_SETTINGS.shopScrapeEnabled)
    expect(r.ldxpScrapeEnabled).toBe(r.shopScrapeEnabled)
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

  it('clamps shopPageConcurrency to 1–10', () => {
    expect(coalesceAppSettings(DEFAULT_APP_SETTINGS, { shopPageConcurrency: 0 }).shopPageConcurrency).toBe(
      1
    )
    expect(
      coalesceAppSettings(DEFAULT_APP_SETTINGS, { shopPageConcurrency: 99 }).shopPageConcurrency
    ).toBe(10)
    expect(
      coalesceAppSettings(DEFAULT_APP_SETTINGS, { shopPageConcurrency: 3.7 }).shopPageConcurrency
    ).toBe(3)
    expect(
      coalesceAppSettings(DEFAULT_APP_SETTINGS, { shopPageConcurrency: 'x' as unknown as number })
        .shopPageConcurrency
    ).toBe(DEFAULT_APP_SETTINGS.shopPageConcurrency)
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
  it('drops invalid shopScrapeEnabled types', () => {
    const p = dualWriteSettingsPatch({
      // @ts-expect-error intentional
      shopScrapeEnabled: 'false'
    })
    expect(p.shopScrapeEnabled).toBeUndefined()
    expect(p.ldxpScrapeEnabled).toBeUndefined()
  })

  it('dual-writes boolean and finite interval', () => {
    expect(dualWriteSettingsPatch({ shopScrapeEnabled: false })).toMatchObject({
      shopScrapeEnabled: false,
      ldxpScrapeEnabled: false
    })
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
})
