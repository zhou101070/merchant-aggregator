import { describe, expect, it } from 'vitest'
import {
  formatJobUserMessage,
  formatSyncProgress,
  formatUserError
} from './sync-labels'

describe('formatJobUserMessage', () => {
  it('maps known shop progress without looking like an error', () => {
    expect(
      formatJobUserMessage({
        message: 'scraping catfk:shop1 (3/10)',
        status: 'running'
      })
    ).toBe('刮取中 3/10')
    expect(
      formatJobUserMessage({
        message: 'ok catfk:shop1 (3/10)',
        status: 'running'
      })
    ).toBe('完成 3/10')
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
        message:
          'upserted 12, dropped no-link 1, deleted stale 2, fingerprint +3/-1',
        status: 'succeeded'
      })
    ).toBe('写入 12 家，无链接丢弃 1，清理陈旧 2，指纹 +3/-1')
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
    expect(line).toContain('刮取中 2/10')
    expect(line).not.toContain('出错了')
  })
})

describe('formatUserError', () => {
  it('maps CODE: message', () => {
    expect(formatUserError(new Error('SYNC_LOCKED: lane busy'))).toBe(
      '已有同步任务进行中'
    )
  })
})
