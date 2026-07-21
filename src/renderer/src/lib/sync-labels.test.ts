import { describe, expect, it } from 'vitest'
import {
  formatDurationMs,
  formatElapsed,
  formatJobUserMessage,
  formatSyncProgress,
  formatUserError,
  parseShopProgressMessage
} from './sync-labels'

describe('formatJobUserMessage', () => {
  it('maps known shop progress without looking like an error', () => {
    expect(
      formatJobUserMessage({
        message: 'scraping catfk:shop1 (3/10)',
        status: 'running'
      })
    ).toBe('正在同步第 3 家，共 10 家')
    expect(
      formatJobUserMessage({
        message: 'ok catfk:shop1 (3/10)',
        status: 'running'
      })
    ).toBe('已完成 3/10 家')
  })

  it('maps success summaries', () => {
    expect(
      formatJobUserMessage({
        message: 'synced 5 shops',
        status: 'succeeded'
      })
    ).toBe('已同步 5 家店')
    expect(
      formatJobUserMessage({
        message: 'nothing to sync (fresh or disabled platforms)',
        status: 'succeeded'
      })
    ).toBe('无需同步（均已新鲜或平台未启用）')
    expect(
      formatJobUserMessage({
        message: 'upserted 12, dropped no-link 1, deleted stale 2, fingerprint +3/-1',
        status: 'succeeded'
      })
    ).toBe('已更新 12 家商家，无链接 1 家未收录，清理过期 2 家')
  })

  it('does not show INTERNAL for in-progress English that is not yet mapped', () => {
    expect(
      formatJobUserMessage({
        message: 'some unknown english progress line',
        status: 'running'
      })
    ).toBe('')
  })

  it('uses INTERNAL only for failed unknown English or INTERNAL code', () => {
    expect(
      formatJobUserMessage({
        message: 'ECONNREFUSED 127.0.0.1',
        status: 'failed',
        errorCode: 'INTERNAL'
      })
    ).toBe('出错了，请稍后重试')
    expect(
      formatJobUserMessage({
        message: 'weird english failure without code',
        status: 'failed'
      })
    ).toBe('出错了，请稍后重试')
  })

  it('prefers error hint when code is present on failure', () => {
    expect(
      formatJobUserMessage({
        message: 'request timed out',
        status: 'failed',
        errorCode: 'TIMEOUT'
      })
    ).toBe('请求超时，请稍后重试')
  })
})

describe('formatSyncProgress', () => {
  it('does not surface 出错了 during active scrape', () => {
    const line = formatSyncProgress({
      jobType: 'shop_all',
      phase: 'shop',
      current: 2,
      total: 10,
      message: 'scraping ldxp:abc (2/10)',
      status: 'running'
    })
    expect(line).toContain('正在同步第 2 家，共 10 家')
    expect(line).not.toContain('出错了')
  })
})

describe('formatUserError', () => {
  it('maps CODE: message', () => {
    expect(formatUserError(new Error('SYNC_LOCKED: lane busy'))).toBe('已有同步任务进行中')
  })
})

describe('formatElapsed', () => {
  const t0 = Date.parse('2026-07-21T12:00:00.000Z')

  it('formats seconds / minutes / hours in Chinese', () => {
    expect(formatElapsed('2026-07-21T12:00:00.000Z', t0 + 32_000)).toBe('32 秒')
    expect(formatElapsed('2026-07-21T12:00:00.000Z', t0 + 192_000)).toBe('3 分 12 秒')
    expect(formatElapsed('2026-07-21T12:00:00.000Z', t0 + 3_600_000)).toBe('1 小时')
    expect(formatElapsed('2026-07-21T12:00:00.000Z', t0 + 3_900_000)).toBe('1 小时 5 分')
  })

  it('returns null for missing/invalid start', () => {
    expect(formatElapsed(null, t0)).toBeNull()
    expect(formatElapsed('not-a-date', t0)).toBeNull()
  })
})

describe('parseShopProgressMessage', () => {
  it('parses scraping / ok / fail with platform and token', () => {
    expect(parseShopProgressMessage('scraping ldxp:abc (3/10)')).toEqual({
      kind: 'scraping',
      platformId: 'ldxp',
      token: 'abc',
      index: 3,
      total: 10
    })
    expect(parseShopProgressMessage('ok catfk:shop1 (3/10)')?.kind).toBe('ok')
    expect(parseShopProgressMessage('fail dujiao:host.example (1/2)')?.kind).toBe('fail')
  })

  it('parses in-shop sub-progress', () => {
    expect(parseShopProgressMessage('ldxp:abc: 12/40')).toEqual({
      kind: 'in_shop',
      platformId: 'ldxp',
      token: 'abc',
      index: 0,
      total: 0,
      subCurrent: 12,
      subTotal: 40
    })
  })
})

describe('formatDurationMs', () => {
  it('formats short durations in Chinese', () => {
    expect(formatDurationMs(200)).toBe('不到 1 秒')
    expect(formatDurationMs(3200)).toBe('3 秒')
    expect(formatDurationMs(80_000)).toBe('1 分 20 秒')
  })
})
