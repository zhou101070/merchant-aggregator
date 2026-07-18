/**
 * While the app runs: per-platform independent random timers.
 * Each tick picks one stale scrapable shop (if any) and starts shop_one.
 * Never full-catalog refresh.
 */
import { AppError } from '@shared/types/errors'
import { enabledScrapablePlatformIds } from '@shared/platforms/shop-profiles'
import type { Repositories } from '../db/repositories'
import type { SyncOrchestrator } from './sync-orchestrator'
import { createLogger } from '../utils/logger'

const log = createLogger('auto-refresh')

function randomBetween(minMs: number, maxMs: number): number {
  const a = Math.min(minMs, maxMs)
  const b = Math.max(minMs, maxMs)
  if (b <= a) return a
  return a + Math.floor(Math.random() * (b - a + 1))
}

function pickRandom<T>(items: T[]): T | null {
  if (!items.length) return null
  return items[Math.floor(Math.random() * items.length)] ?? null
}

export type AutoRefreshPlatformState = {
  platformId: string
  nextAt: string | null
  lastAt: string | null
  lastMerchantId: string | null
  lastResult: string | null
}

export class AutoRefreshScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly nextAtMs = new Map<string, number>()
  private readonly lastAtMs = new Map<string, number>()
  private readonly lastMerchantId = new Map<string, string>()
  private readonly lastResult = new Map<string, string>()
  private running = false

  constructor(
    private readonly repos: Repositories,
    private readonly sync: SyncOrchestrator
  ) {}

  /** Start or restart all platform chains from current settings. */
  start(): void {
    this.stopTimersOnly()
    this.running = true
    const settings = this.repos.settings.get()
    if (!settings.autoRefreshEnabled) {
      log.info('auto-refresh disabled in settings')
      return
    }
    const platforms = enabledScrapablePlatformIds()
    log.info('auto-refresh start', {
      platforms,
      minMs: settings.autoRefreshMinIntervalMs,
      maxMs: settings.autoRefreshMaxIntervalMs
    })
    for (const p of platforms) {
      this.arm(p, true)
    }
  }

  stop(): void {
    this.running = false
    this.stopTimersOnly()
    log.info('auto-refresh stopped')
  }

  /** Call after settings that affect scheduling change. */
  reschedule(): void {
    if (!this.running && this.repos.settings.get().autoRefreshEnabled) {
      this.start()
      return
    }
    if (!this.repos.settings.get().autoRefreshEnabled) {
      this.stopTimersOnly()
      return
    }
    this.start()
  }

  status(): {
    running: boolean
    enabled: boolean
    platforms: AutoRefreshPlatformState[]
  } {
    const settings = this.repos.settings.get()
    const platforms = enabledScrapablePlatformIds().map((platformId) => ({
      platformId,
      nextAt: this.nextAtMs.has(platformId)
        ? new Date(this.nextAtMs.get(platformId)!).toISOString()
        : null,
      lastAt: this.lastAtMs.has(platformId)
        ? new Date(this.lastAtMs.get(platformId)!).toISOString()
        : null,
      lastMerchantId: this.lastMerchantId.get(platformId) ?? null,
      lastResult: this.lastResult.get(platformId) ?? null
    }))
    return {
      running: this.running && settings.autoRefreshEnabled,
      enabled: settings.autoRefreshEnabled,
      platforms
    }
  }

  private stopTimersOnly(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    this.nextAtMs.clear()
  }

  private arm(platformId: string, initial: boolean): void {
    if (!this.running) return
    const settings = this.repos.settings.get()
    if (!settings.autoRefreshEnabled) return

    const delay = randomBetween(
      settings.autoRefreshMinIntervalMs,
      settings.autoRefreshMaxIntervalMs
    )
    // Stagger first fire so platforms don't all hit at once after launch
    const firstBoost = initial ? randomBetween(5_000, Math.min(delay, 90_000)) : delay
    const wait = initial ? firstBoost : delay
    const next = Date.now() + wait
    this.nextAtMs.set(platformId, next)

    const prev = this.timers.get(platformId)
    if (prev) clearTimeout(prev)

    const handle = setTimeout(() => {
      void this.tick(platformId)
    }, wait)
    this.timers.set(platformId, handle)

    log.debug('armed', { platformId, waitMs: wait, initial })
  }

  private async tick(platformId: string): Promise<void> {
    if (!this.running) return
    try {
      await this.runTick(platformId)
    } catch (err) {
      this.lastResult.set(platformId, err instanceof Error ? err.message : String(err))
      log.warn('tick error', { platformId, err: String(err) })
    } finally {
      if (this.running) this.arm(platformId, false)
    }
  }

  private async runTick(platformId: string): Promise<void> {
    const settings = this.repos.settings.get()
    if (!settings.autoRefreshEnabled) {
      this.lastResult.set(platformId, 'disabled')
      return
    }
    if (settings.networkPaused) {
      this.lastResult.set(platformId, 'network_paused')
      return
    }
    if (!(settings.shopScrapeEnabled ?? settings.ldxpScrapeEnabled)) {
      this.lastResult.set(platformId, 'shop_scrape_off')
      return
    }

    const pool = this.repos.merchants.listScrapableNeedingSync({
      freshHours: settings.shopFreshHours,
      platformIds: [platformId],
      // 失败店留给用户手动重试；成功前不再被后台随机抽到
      excludeFailing: true
    })
    const pick = pickRandom(pool)
    if (!pick) {
      this.lastResult.set(platformId, 'no_stale')
      log.debug('no stale shop', { platformId })
      return
    }

    this.lastAtMs.set(platformId, Date.now())
    this.lastMerchantId.set(platformId, pick.id)

    try {
      const { jobId } = this.sync.start({
        jobType: 'shop_one',
        merchantId: pick.id,
        platformId: pick.shopPlatform,
        token: pick.shopToken,
        // 不打开系统浏览器；失败标 failing 后本池会排除
        background: true
      })
      this.lastResult.set(platformId, `started:${jobId.slice(0, 8)}`)
      log.info('auto shop_one', {
        platformId,
        merchantId: pick.id,
        name: pick.name,
        jobId
      })
    } catch (err) {
      if (err instanceof AppError && err.code === 'SYNC_LOCKED') {
        this.lastResult.set(platformId, 'sync_locked')
        log.debug('lane busy, skip', { platformId })
        return
      }
      throw err
    }
  }
}

let singleton: AutoRefreshScheduler | null = null

export function getAutoRefreshScheduler(): AutoRefreshScheduler | null {
  return singleton
}

export function initAutoRefreshScheduler(
  repos: Repositories,
  sync: SyncOrchestrator
): AutoRefreshScheduler {
  singleton = new AutoRefreshScheduler(repos, sync)
  return singleton
}
