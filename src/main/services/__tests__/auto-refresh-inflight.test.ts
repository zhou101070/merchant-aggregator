import { describe, expect, it, vi } from 'vitest'
import { AutoRefreshScheduler } from '../auto-refresh-scheduler'

/**
 * Unit-level: when a platform already has an in-flight background job,
 * the next tick must not start another for the same platform.
 * (Cross-platform ticks remain independent / parallel.)
 */
describe('AutoRefreshScheduler in-flight guard', () => {
  it('skips start when previous job for platform is still running', async () => {
    const start = vi.fn(() => ({ jobId: 'job-2' }))
    const isJobRunning = vi.fn((id: string) => id === 'job-1')
    const listScrapableNeedingSync = vi.fn(() => [
      {
        id: 'm1',
        name: 'shop',
        shopPlatform: 'ldxp',
        shopToken: 't1'
      }
    ])
    const getSettings = vi.fn(() => ({
      autoRefreshEnabled: true,
      shopFreshMinutes: 24 * 60,
      shopFreshUnit: 'hours',
      shopFreshHours: 24,
      autoRefreshMinIntervalMs: 60_000,
      autoRefreshMaxIntervalMs: 120_000
    }))

    const repos = {
      settings: { get: getSettings },
      merchants: { listScrapableNeedingSync }
    } as never
    const sync = { start, isJobRunning } as never

    const scheduler = new AutoRefreshScheduler(repos, sync)
    // Seed active job as if a previous tick started it
    ;(scheduler as unknown as { activeJobByPlatform: Map<string, string> }).activeJobByPlatform.set(
      'ldxp',
      'job-1'
    )
    ;(scheduler as unknown as { running: boolean }).running = true

    await (
      scheduler as unknown as { runTick: (p: string) => Promise<void> }
    ).runTick('ldxp')

    expect(isJobRunning).toHaveBeenCalledWith('job-1')
    expect(start).not.toHaveBeenCalled()
    expect(listScrapableNeedingSync).not.toHaveBeenCalled()
  })
})
