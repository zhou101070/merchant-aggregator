import { describe, expect, it } from 'vitest'
import { isBackgroundSyncJob } from './useSync'

describe('isBackgroundSyncJob', () => {
  it('detects meta.background on job records', () => {
    expect(isBackgroundSyncJob({ meta: { background: true } })).toBe(true)
    expect(isBackgroundSyncJob({ meta: { background: false } })).toBe(false)
    expect(isBackgroundSyncJob({ meta: null })).toBe(false)
  })

  it('detects background flag on progress events', () => {
    expect(isBackgroundSyncJob({ background: true })).toBe(true)
    expect(isBackgroundSyncJob({ background: false })).toBe(false)
    expect(isBackgroundSyncJob(null)).toBe(false)
  })
})
