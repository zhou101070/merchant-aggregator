import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import { AppError, type AppErrorCode } from '@shared/types/errors'
import {
  isShopJob,
  mergeLastSuccessAt,
  normalizeJobType,
  type SyncJobType,
  type SyncProgressEvent,
  type SyncStartRequest,
  type SyncStatus
} from '@shared/types/sync'
import { IPC_CHANNELS } from '@shared/types/ipc'
import { BOOTSTRAP_TOP_N } from '@shared/constants'
import { parseShopUrl } from '@shared/lib/url-parse'
import { SHOP_PROFILES } from '@shared/platforms/shop-profiles'
import { findProfileById } from '@shared/platforms/shop-types'
import type { Repositories } from '../db/repositories'
import { createLogger } from '../utils/logger'
import { fetchAllMerchants } from '../platforms/priceai/fetcher-merchants'
import { PriceaiClient } from '../platforms/priceai/client'
import { scrapeShopTarget, type ShopScrapeTarget } from '../platforms/registry'

const log = createLogger('sync')

type Lane = 'priceai' | 'shop'

function lanesFor(jobType: SyncJobType): Lane[] {
  if (jobType === 'merchants') return ['priceai']
  if (jobType === 'bootstrap') return ['priceai', 'shop']
  if (isShopJob(jobType)) return ['shop']
  return ['shop']
}

interface RunningJob {
  id: string
  jobType: SyncJobType
  requestedJobType: SyncJobType
  lanes: Lane[]
  controller: AbortController
  startedAt: string
}

export class SyncOrchestrator {
  private readonly running = new Map<string, RunningJob>()
  private readonly laneOwner = new Map<Lane, string>()

  constructor(private readonly repos: Repositories) {
    const n = this.repos.syncJobs.cancelOrphanedRunning()
    if (n > 0) {
      log.warn('cleared orphaned sync jobs from previous session', { count: n })
    }
  }

  getStatus(): SyncStatus {
    const scrapable = this.repos.merchants.countScrapable()
    return {
      running: this.repos.syncJobs.listRunning(),
      recent: this.repos.syncJobs.listRecent(20),
      lastSuccessAt: mergeLastSuccessAt(this.repos.syncJobs.lastSuccessAt()),
      counts: {
        merchants: this.repos.merchants.count(),
        shopProducts: this.repos.shopProducts.count(),
        ldxpMerchants: scrapable,
        scrapableMerchants: scrapable
      }
    }
  }

  start(req: SyncStartRequest): { jobId: string } {
    const settings = this.repos.settings.get()
    if (settings.networkPaused) {
      throw new AppError('PAUSED', 'network sync is paused')
    }

    const requestedJobType = req.jobType
    const jobType = normalizeJobType(req.jobType)

    const lanes = lanesFor(jobType)
    for (const lane of lanes) {
      if (this.laneOwner.has(lane)) {
        throw new AppError('SYNC_LOCKED', `${lane} lane already running`)
      }
    }

    const shopScrapeOn = settings.shopScrapeEnabled ?? settings.ldxpScrapeEnabled
    if (isShopJob(jobType) && !shopScrapeOn) {
      throw new AppError('PAUSED', 'shop scrape disabled in settings')
    }
    // bootstrap: allow merchants phase even when shop scrape off (D17)

    if (jobType === 'shop_one') {
      const target = this.resolveShopTarget(req)
      if (!target.token || !target.platformId) {
        throw new AppError('NOT_FOUND', 'shop platform + token required (or shopUrl)')
      }
      const profile = findProfileById(target.platformId, SHOP_PROFILES)
      if (!profile) throw new AppError('NOT_FOUND', `unknown platform ${target.platformId}`)
      if (!profile.enabled) {
        throw new AppError('PAUSED', `platform ${profile.id} scrape not enabled yet`, {
          platformId: profile.id,
          probeStatus: profile.probeStatus
        })
      }
    }
    if (jobType === 'shop_selected') {
      const ids = req.merchantIds?.filter(Boolean) ?? []
      if (!ids.length) throw new AppError('NOT_FOUND', 'select at least one merchant')
    }

    const jobId = randomUUID()
    const controller = new AbortController()
    const startedAt = new Date().toISOString()

    this.repos.syncJobs.insert({
      id: jobId,
      jobType,
      status: 'running',
      phase: 'starting',
      current: 0,
      total: 0,
      message: 'starting',
      startedAt,
      meta: {
        requestedJobType,
        merchantId: req.merchantId,
        token: req.token,
        platformId: req.platformId,
        shopUrl: req.shopUrl,
        merchantIds: req.merchantIds
      }
    })

    this.running.set(jobId, {
      id: jobId,
      jobType,
      requestedJobType,
      lanes,
      controller,
      startedAt
    })
    for (const lane of lanes) this.laneOwner.set(lane, jobId)

    this.emitProgress({
      jobId,
      jobType,
      requestedJobType,
      phase: 'starting',
      current: 0,
      total: 0,
      message: 'starting',
      status: 'running'
    })

    void this.runJob(jobId, jobType, controller.signal, {
      merchantId: req.merchantId,
      token: req.token,
      platformId: req.platformId,
      shopUrl: req.shopUrl,
      merchantIds: req.merchantIds,
      force: req.force
    }).finally(() => {
      this.running.delete(jobId)
      for (const lane of lanes) {
        if (this.laneOwner.get(lane) === jobId) this.laneOwner.delete(lane)
      }
    })

    return { jobId }
  }

  cancel(jobId: string): { ok: boolean } {
    const job = this.running.get(jobId)
    if (job) {
      job.controller.abort()
      return { ok: true }
    }
    const record = this.repos.syncJobs.get(jobId)
    if (record && (record.status === 'running' || record.status === 'pending')) {
      this.repos.syncJobs.update(jobId, {
        status: 'cancelled',
        message: 'cancelled (no active worker)',
        errorCode: 'CANCELLED',
        finishedAt: new Date().toISOString()
      })
      this.emitProgress({
        jobId,
        jobType: record.jobType,
        phase: record.phase ?? 'cancelled',
        current: record.current,
        total: record.total,
        message: 'cancelled',
        status: 'cancelled',
        errorCode: 'CANCELLED'
      })
      return { ok: true }
    }
    return { ok: false }
  }

  cancelAll(): { ok: boolean; count: number } {
    const ids = new Set<string>([
      ...this.running.keys(),
      ...this.repos.syncJobs.listRunning().map((j) => j.id)
    ])
    let count = 0
    for (const id of ids) {
      if (this.cancel(id).ok) count += 1
    }
    count += this.repos.syncJobs.cancelOrphanedRunning('cancelled by user')
    this.laneOwner.clear()
    return { ok: count > 0, count }
  }

  /**
   * Resolve scrape target. Priority (design §4):
   * shopUrl → platformId+token → merchantId → bare token (legacy default ldxp).
   * Never uses product item URLs as shop roots.
   */
  resolveShopTarget(req: {
    merchantId?: string
    token?: string
    platformId?: string
    shopUrl?: string
  }): ShopScrapeTarget {
    if (req.shopUrl?.trim()) {
      const parsed = parseShopUrl(req.shopUrl.trim())
      if (!parsed) {
        throw new AppError('INVALID_URL', 'unrecognized shop URL', { shopUrl: req.shopUrl })
      }
      let merchantId = req.merchantId ?? null
      if (!merchantId) {
        const m = this.repos.merchants.findByShopRef(parsed.platformId, parsed.token)
        if (m) merchantId = m.id
      }
      return {
        platformId: parsed.platformId,
        token: parsed.token,
        merchantId,
        label: parsed.shopUrl
      }
    }

    if (req.token && req.platformId) {
      const m = this.repos.merchants.findByShopRef(req.platformId, req.token)
      return {
        platformId: req.platformId,
        token: req.token,
        merchantId: m?.id ?? req.merchantId ?? null
      }
    }

    if (req.merchantId) {
      const m = this.repos.merchants.getById(req.merchantId)
      if (!m) throw new AppError('NOT_FOUND', 'merchant not found')
      let platformId = req.platformId || m.shopPlatform || null
      let token = req.token || m.shopToken || null
      // Lazy backfill: parse merchant shop_url / entry_url when shop_* empty
      if (!platformId || !token) {
        const parsed = parseShopUrl(m.shopUrl) || parseShopUrl(m.entryUrl)
        if (parsed) {
          platformId = platformId || parsed.platformId
          token = token || parsed.token
        }
      }
      if (!platformId && m.ldxpToken) {
        platformId = 'ldxp'
        token = token || m.ldxpToken
      }
      if (!platformId || !token) {
        throw new AppError('NOT_FOUND', 'merchant has no scrapable shop ref')
      }
      return { platformId, token, merchantId: m.id, label: m.name }
    }

    // bare token without platform → default ldxp (legacy IPC only)
    if (req.token) {
      const m = this.repos.merchants.findByShopRef('ldxp', req.token)
      return {
        platformId: 'ldxp',
        token: req.token,
        merchantId: m?.id ?? null
      }
    }

    return { platformId: '', token: '', merchantId: null }
  }

  private async runJob(
    jobId: string,
    jobType: SyncJobType,
    signal: AbortSignal,
    ctx: {
      merchantId?: string
      token?: string
      platformId?: string
      shopUrl?: string
      merchantIds?: string[]
      force?: boolean
    }
  ): Promise<void> {
    try {
      const settings = this.repos.settings.get()
      const minInterval = settings.shopMinIntervalMs ?? settings.ldxpMinIntervalMs
      const enabledIds = SHOP_PROFILES.filter((p) => p.enabled).map((p) => p.id)

      if (jobType === 'merchants') {
        const client = new PriceaiClient({ userAgent: settings.priceaiUa })
        await this.runMerchants(jobId, signal, client, settings.requestIntervalMs)
      } else if (jobType === 'bootstrap') {
        const client = new PriceaiClient({ userAgent: settings.priceaiUa })
        const merchants = await this.fetchMerchantsPhase(
          jobId,
          'bootstrap',
          signal,
          client,
          settings.requestIntervalMs
        )
        const shopOn = settings.shopScrapeEnabled ?? settings.ldxpScrapeEnabled
        if (!shopOn) {
          this.finishSuccess(
            jobId,
            'bootstrap',
            'done',
            merchants.rows.length,
            merchants.rows.length,
            `merchants ${merchants.rows.length}; shop scrape disabled, skipped deep scrape`,
            { merchantsUpserted: merchants.rows.length, shopSkipped: true }
          )
          return
        }
        const targets = this.repos.merchants.listScrapableNeedingSync({
          freshHours: settings.shopFreshHours,
          limit: BOOTSTRAP_TOP_N,
          platformIds: enabledIds
        })
        if (!targets.length) {
          this.finishSuccess(
            jobId,
            'bootstrap',
            'done',
            merchants.rows.length,
            merchants.rows.length,
            `merchants ${merchants.rows.length}; top shops all fresh`,
            { merchantsUpserted: merchants.rows.length }
          )
          return
        }
        await this.runShopQueue(
          jobId,
          'bootstrap',
          signal,
          targets.map((m) => ({
            platformId: m.shopPlatform,
            token: m.shopToken,
            merchantId: m.id
          })),
          minInterval,
          { extraMeta: { merchantsUpserted: merchants.rows.length } }
        )
      } else if (jobType === 'shop_one') {
        const target = this.resolveShopTarget(ctx)
        await this.runShopQueue(jobId, jobType, signal, [target], minInterval)
      } else if (jobType === 'shop_selected') {
        const targets = (ctx.merchantIds ?? [])
          .map((id) => {
            try {
              return this.resolveShopTarget({ merchantId: id })
            } catch {
              return null
            }
          })
          .filter((t): t is ShopScrapeTarget => !!t && !!t.token && !!t.platformId)
          .filter((t) => {
            const p = findProfileById(t.platformId, SHOP_PROFILES)
            return p?.enabled === true
          })
        if (!targets.length) {
          throw new AppError('NOT_FOUND', 'no scrapable shop ref on selected merchants')
        }
        await this.runShopQueue(jobId, jobType, signal, targets, minInterval)
      } else if (jobType === 'shop_all') {
        const totalScrapable = this.repos.merchants.countScrapable()
        if (!totalScrapable) throw new AppError('NOT_FOUND', 'no scrapable merchants in local db')
        const all = ctx.force
          ? this.repos.merchants.listScrapableMerchants()
          : this.repos.merchants.listScrapableNeedingSync({
              freshHours: settings.shopFreshHours
            })
        // D15/D16: filter disabled platforms
        const targets = all
          .filter((m) => enabledIds.includes(m.shopPlatform))
          .map((m) => ({
            platformId: m.shopPlatform,
            token: m.shopToken,
            merchantId: m.id
          }))
        const skippedDisabled = all.length - targets.length
        if (!targets.length) {
          this.finishSuccess(
            jobId,
            jobType,
            'done',
            0,
            0,
            `nothing to sync (fresh or disabled platforms)`,
            {
              skippedFresh: ctx.force ? 0 : totalScrapable - all.length,
              skippedDisabled
            }
          )
          return
        }
        await this.runShopQueue(jobId, jobType, signal, targets, minInterval, {
          skippedFresh: ctx.force ? 0 : totalScrapable - all.length,
          extraMeta: { skippedDisabled }
        })
      } else {
        throw new AppError('INTERNAL', `unknown job type ${jobType}`)
      }
    } catch (err) {
      this.finishError(jobId, jobType, err)
    }
  }

  private async fetchMerchantsPhase(
    jobId: string,
    jobType: SyncJobType,
    signal: AbortSignal,
    client: PriceaiClient,
    intervalMs: number
  ): Promise<Awaited<ReturnType<typeof fetchAllMerchants>> & { deletedNoLink: number }> {
    const result = await fetchAllMerchants({
      client,
      intervalMs,
      signal,
      onProgress: (p) =>
        this.progress(jobId, jobType, 'merchants', p.current, p.total, `page ${p.page}`)
    })
    this.repos.merchants.upsertMany(result.rows)
    const deletedNoLink = this.repos.merchants.deleteWithoutExternalLinks()
    return { ...result, deletedNoLink }
  }

  private async runMerchants(
    jobId: string,
    signal: AbortSignal,
    client: PriceaiClient,
    intervalMs: number
  ): Promise<void> {
    const result = await this.fetchMerchantsPhase(jobId, 'merchants', signal, client, intervalMs)
    this.finishSuccess(
      jobId,
      'merchants',
      'merchants',
      result.rows.length,
      result.total,
      `upserted ${result.rows.length}, dropped no-link ${result.droppedNoLink}, deleted stale ${result.deletedNoLink}`,
      {
        pages: result.pages,
        generatedAt: result.generatedAt,
        fetchedUnique: result.fetchedUnique,
        droppedNoLink: result.droppedNoLink,
        deletedNoLink: result.deletedNoLink
      }
    )
  }

  private async runShopQueue(
    jobId: string,
    jobType: SyncJobType,
    signal: AbortSignal,
    targets: ShopScrapeTarget[],
    minIntervalMs: number,
    opts?: { skippedFresh?: number; extraMeta?: Record<string, unknown> }
  ): Promise<void> {
    let done = 0
    let failed = 0
    const errors: {
      merchantId: string | null
      platformId: string
      token: string
      message: string
      code?: string
      details?: unknown
    }[] = []
    const total = targets.length

    for (const target of targets) {
      if (signal.aborted) throw new AppError('CANCELLED', 'cancelled')
      this.progress(
        jobId,
        jobType,
        'shop',
        done,
        total,
        `scraping ${target.platformId}:${target.token} (${done + 1}/${total})`
      )
      if (target.merchantId) {
        this.repos.merchants.setAppHealth(target.merchantId, 'retrying')
      } else {
        this.repos.merchants.setAppHealthByShopRef(target.platformId, target.token, 'retrying')
      }
      try {
        const result = await scrapeShopTarget({
          target,
          minIntervalMs,
          signal,
          onProgress: (p) =>
            this.progress(
              jobId,
              jobType,
              p.phase,
              done,
              total,
              `${target.platformId}:${target.token}: ${p.current}/${p.total}`
            )
        })
        this.repos.shopProducts.upsertMany(result.rows)
        if (target.merchantId) {
          this.repos.merchants.setAppHealth(target.merchantId, 'healthy')
          this.repos.merchants.relinkShopProducts(
            target.platformId,
            target.token,
            target.merchantId
          )
        } else {
          this.repos.merchants.setAppHealthByShopRef(target.platformId, target.token, 'healthy')
        }
        done += 1
      } catch (err) {
        if (err instanceof AppError && err.code === 'CANCELLED') throw err
        failed += 1
        done += 1
        const message = err instanceof Error ? err.message : String(err)
        const code = err instanceof AppError ? err.code : 'INTERNAL'
        const details = err instanceof AppError ? err.details : undefined
        errors.push({
          merchantId: target.merchantId,
          platformId: target.platformId,
          token: target.token,
          message,
          code,
          details
        })
        if (target.merchantId) {
          this.repos.merchants.setAppHealth(target.merchantId, 'failing', message)
        } else {
          this.repos.merchants.setAppHealthByShopRef(
            target.platformId,
            target.token,
            'failing',
            message
          )
        }
        log.warn('shop scrape failed', {
          platformId: target.platformId,
          token: target.token,
          code,
          message,
          details
        })
      }
    }

    const skippedNote = opts?.skippedFresh ? `, skipped ${opts.skippedFresh} fresh` : ''
    const statusMessage =
      (failed === 0
        ? `synced ${total} shops`
        : `synced ${total - failed}/${total} shops, ${failed} failed`) + skippedNote
    const finishedAt = new Date().toISOString()
    const finalStatus = failed === 0 ? 'succeeded' : failed === total ? 'failed' : 'partial'
    this.repos.syncJobs.update(jobId, {
      status: finalStatus,
      phase: 'done',
      current: total,
      total,
      message: statusMessage,
      errorCode: failed ? 'NETWORK' : null,
      finishedAt,
      meta: {
        errors: errors.slice(0, 50),
        failed,
        ok: total - failed,
        skippedFresh: opts?.skippedFresh ?? 0,
        ...(opts?.extraMeta ?? {})
      }
    })
    this.emitProgress({
      jobId,
      jobType,
      phase: 'done',
      current: total,
      total,
      message: statusMessage,
      status: finalStatus,
      errorCode: failed ? 'NETWORK' : undefined
    })
    log.info('shop queue finished', { jobId, jobType, total, failed })
  }

  private progress(
    jobId: string,
    jobType: SyncJobType,
    phase: string,
    current: number,
    total: number,
    message: string
  ): void {
    this.repos.syncJobs.update(jobId, {
      status: 'running',
      phase,
      current,
      total,
      message
    })
    this.emitProgress({
      jobId,
      jobType,
      phase,
      current,
      total,
      message,
      status: 'running'
    })
  }

  private finishSuccess(
    jobId: string,
    jobType: SyncJobType,
    phase: string,
    current: number,
    total: number,
    message: string,
    meta?: Record<string, unknown>
  ): void {
    const finishedAt = new Date().toISOString()
    const prev = this.repos.syncJobs.get(jobId)
    this.repos.syncJobs.update(jobId, {
      status: 'succeeded',
      phase,
      current,
      total,
      message,
      finishedAt,
      meta: { ...(prev?.meta ?? {}), ...(meta ?? {}) }
    })
    this.emitProgress({
      jobId,
      jobType,
      phase,
      current,
      total,
      message,
      status: 'succeeded'
    })
    log.info('sync succeeded', { jobId, jobType, message })
  }

  private finishError(jobId: string, jobType: SyncJobType, err: unknown): void {
    const code: AppErrorCode = err instanceof AppError ? err.code : 'INTERNAL'
    const message = err instanceof Error ? err.message : String(err)
    const details = err instanceof AppError ? err.details : undefined
    const status = code === 'CANCELLED' ? 'cancelled' : 'failed'
    const finishedAt = new Date().toISOString()
    const prev = this.repos.syncJobs.get(jobId)
    this.repos.syncJobs.update(jobId, {
      status,
      message,
      errorCode: code,
      finishedAt,
      meta: {
        ...(prev?.meta ?? {}),
        failure: { code, message, details }
      }
    })
    this.emitProgress({
      jobId,
      jobType,
      phase: prev?.phase ?? 'error',
      current: prev?.current ?? 0,
      total: prev?.total ?? 0,
      message,
      status,
      errorCode: code
    })
    log.warn('sync ended', { jobId, jobType, status, code, message, details })
  }

  private emitProgress(event: SyncProgressEvent): void {
    const running = this.running.get(event.jobId)
    const payload: SyncProgressEvent = {
      ...event,
      startedAt: event.startedAt ?? running?.startedAt,
      requestedJobType: event.requestedJobType ?? running?.requestedJobType
    }
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_CHANNELS.syncProgress, payload)
    }
  }
}
