import { randomUUID } from 'node:crypto'
import { BrowserWindow, Notification } from 'electron'
import { formatErrorWithDetails, primaryErrorCode } from '@shared/lib/error-format'
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
import { APP_NAME, BOOTSTRAP_TOP_N, RATE_LIMITS } from '@shared/constants'
import {
  DUJIAO_PLATFORM_ID,
  YICIYUAN_PLATFORM_ID,
  identifyShopPlatform,
  identityToScrapeRef
} from '@shared/platforms/identify'
import { enabledScrapablePlatformIds, SHOP_PROFILES } from '@shared/platforms/shop-profiles'
import { findProfileById } from '@shared/platforms/shop-types'
import { resolveDujiaoBaseUrl } from '../platforms/dujiao/client'
import { resolveYiciyuanBaseUrl } from '../platforms/yiciyuan/client'
import { parseAutopixelShopRef } from '../platforms/autopixel/client'
import { probeYiciyuan } from '../platforms/fingerprint/probe'
import { getHostLimiter, hostKey, mapWithConcurrency } from './rate-limiter'
import { runHostGroupedQueue } from './shop-queue'
import { shouldBlockMerchantAfterSyncFailure } from './sync-failure-policy'
import { enterSyncRequestScope, leaveSyncRequestScope } from './sync-request-log'
import type { Repositories } from '../db/repositories'
import { createLogger } from '../utils/logger'
import { fetchAllMerchants } from '../platforms/priceai/fetcher-merchants'
import { PriceaiClient } from '../platforms/priceai/client'
import { fetchAllNodebitsMerchants } from '../platforms/nodebits/fetcher-merchants'
import { NodebitsClient } from '../platforms/nodebits/client'
import { scrapeShopTarget, type ShopScrapeTarget } from '../platforms/registry'
import {
  canBuildUnknownTrialTarget,
  isSilentUnknownFailure,
  shouldTrialUnknownPlatform
} from '../platforms/unknown-platform-scrape'
import type { JobPoolSnapshot } from '@shared/types/sync'

const log = createLogger('sync')

/**
 * Whether a resolved shop target may enter shop_selected / batch product sync.
 * - Known enabled platforms (shopapi + host-token ids)
 * - Unknown-platform trial targets (try modes at scrape; all-fail silent)
 * Disabled shopapi profiles stay excluded.
 */
export function isSelectableShopTarget(
  t: ShopScrapeTarget | null | undefined,
  enabledIds: readonly string[]
): t is ShopScrapeTarget {
  if (!t?.token || !t.platformId) return false
  if (t.trialUnknownPlatform) return true
  return enabledIds.includes(t.platformId)
}

function resolveHostTokenBaseUrl(
  platformId: string,
  opts: { host: string; shopUrl?: string | null; entryUrl?: string | null }
): string | null {
  if (platformId === DUJIAO_PLATFORM_ID) {
    return resolveDujiaoBaseUrl({
      host: opts.host,
      shopUrl: opts.shopUrl,
      entryUrl: opts.entryUrl
    })
  }
  if (platformId === YICIYUAN_PLATFORM_ID || platformId === 'kami') {
    return resolveYiciyuanBaseUrl({
      host: opts.host,
      shopUrl: opts.shopUrl,
      entryUrl: opts.entryUrl
    })
  }
  if (platformId === 'autopixel') {
    const ref = parseAutopixelShopRef({
      shopUrl: opts.shopUrl,
      entryUrl: opts.entryUrl,
      token: opts.host
    })
    return ref?.baseUrl ?? null
  }
  return null
}

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
  /** Auto-refresh etc.: does not take exclusive lanes */
  background: boolean
}

export class SyncOrchestrator {
  private readonly running = new Map<string, RunningJob>()
  private readonly laneOwner = new Map<Lane, string>()
  /** Live + last pool snapshot per job (memory only) */
  private readonly poolSnapshots = new Map<string, JobPoolSnapshot>()

  constructor(private readonly repos: Repositories) {
    const n = this.repos.syncJobs.cancelOrphanedRunning()
    if (n > 0) {
      log.warn('cleared orphaned sync jobs from previous session', { count: n })
    }
  }

  getPoolSnapshot(jobId: string): JobPoolSnapshot | null {
    return this.poolSnapshots.get(jobId) ?? null
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

  /** Whether a job is still executing in-process (not merely a stale DB row). */
  isJobRunning(jobId: string): boolean {
    return this.running.has(jobId)
  }

  start(req: SyncStartRequest): { jobId: string } {
    const requestedJobType = req.jobType
    const jobType = normalizeJobType(req.jobType)
    if (!jobType) {
      throw new AppError('INTERNAL', `unknown job type ${String(req.jobType)}`, {
        jobType: req.jobType
      })
    }

    const background = req.background === true
    const lanes = lanesFor(jobType)
    // Foreground jobs keep exclusive lanes so two bulk scrapes don't pile on.
    // Background auto-refresh runs in parallel with user jobs (and each other).
    if (!background) {
      for (const lane of lanes) {
        if (this.laneOwner.has(lane)) {
          throw new AppError('SYNC_LOCKED', `${lane} lane already running`)
        }
      }
    }

    if (jobType === 'shop_one') {
      const target = this.resolveShopTarget(req)
      if (!target.token || !target.platformId) {
        throw new AppError('NOT_FOUND', 'shop platform + token required (or shopUrl)')
      }
      if (target.trialUnknownPlatform) {
        // Unknown platform: trial known modes at scrape time; all-fail is silent
      } else if (
        target.platformId === DUJIAO_PLATFORM_ID ||
        target.platformId === YICIYUAN_PLATFORM_ID ||
        target.platformId === 'kami' ||
        target.platformId === 'autopixel'
      ) {
        // host-as-token / path-token families; always enabled when resolved
      } else {
        const profile = findProfileById(target.platformId, SHOP_PROFILES)
        if (!profile) throw new AppError('NOT_FOUND', `unknown platform ${target.platformId}`)
        if (!profile.enabled) {
          throw new AppError('PAUSED', `platform ${profile.id} scrape not enabled yet`, {
            platformId: profile.id,
            probeStatus: profile.probeStatus
          })
        }
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
        merchantIds: req.merchantIds,
        background
      }
    })

    this.running.set(jobId, {
      id: jobId,
      jobType,
      requestedJobType,
      lanes,
      controller,
      startedAt,
      background
    })
    if (!background) {
      for (const lane of lanes) this.laneOwner.set(lane, jobId)
    }

    this.emitProgress({
      jobId,
      jobType,
      requestedJobType,
      phase: 'starting',
      current: 0,
      total: 0,
      message: 'starting',
      status: 'running',
      background
    })

    void this.runJob(jobId, jobType, controller.signal, {
      merchantId: req.merchantId,
      token: req.token,
      platformId: req.platformId,
      shopUrl: req.shopUrl,
      merchantIds: req.merchantIds,
      force: req.force,
      background
    }).finally(() => {
      this.running.delete(jobId)
      if (!background) {
        for (const lane of lanes) {
          if (this.laneOwner.get(lane) === jobId) this.laneOwner.delete(lane)
        }
      }
    })

    return { jobId }
  }

  cancel(jobId: string): { ok: boolean } {
    const job = this.running.get(jobId)
    if (job) {
      job.controller.abort()
      // Immediate UI/DB terminal so busy clears without waiting for in-flight scrape
      this.markCancelledImmediate(jobId, job.jobType, job.requestedJobType)
      return { ok: true }
    }
    const record = this.repos.syncJobs.get(jobId)
    if (record && (record.status === 'running' || record.status === 'pending')) {
      this.markCancelledImmediate(jobId, record.jobType, undefined, record)
      return { ok: true }
    }
    return { ok: false }
  }

  private markCancelledImmediate(
    jobId: string,
    jobType: SyncJobType,
    requestedJobType?: SyncJobType,
    record?: { status?: string; phase?: string | null; current?: number; total?: number }
  ): void {
    const prev = record ?? this.repos.syncJobs.get(jobId)
    if (prev?.status && ['succeeded', 'failed', 'partial', 'cancelled'].includes(prev.status)) {
      return
    }
    const finishedAt = new Date().toISOString()
    this.repos.syncJobs.update(jobId, {
      status: 'cancelled',
      message: 'cancelled by user',
      errorCode: 'CANCELLED',
      finishedAt
    })
    this.emitProgress({
      jobId,
      jobType,
      requestedJobType,
      phase: prev?.phase ?? 'cancelled',
      current: prev?.current ?? 0,
      total: prev?.total ?? 0,
      message: 'cancelled by user',
      status: 'cancelled',
      errorCode: 'CANCELLED'
    })
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
   * Resolve scrape target via identifyShopPlatform.
   * Priority (design §4): shopUrl → platformId+token → merchantId → bare token (legacy ldxp).
   * Unknown / non-scrapable with host or token → trialUnknownPlatform target (modes tried at scrape).
   * Never uses product item URLs as shop roots.
   */
  resolveShopTarget(req: {
    merchantId?: string
    token?: string
    platformId?: string
    shopUrl?: string
  }): ShopScrapeTarget {
    if (req.shopUrl?.trim()) {
      const shopUrl = req.shopUrl.trim()
      const identity = identifyShopPlatform({ shopUrl })
      const ref = identityToScrapeRef(identity)
      if (!ref) {
        const trial = this.buildUnknownTrialTarget({
          identity,
          merchantId: req.merchantId ?? null,
          shopUrl,
          entryUrl: shopUrl,
          label: shopUrl
        })
        if (trial) return trial
        throw new AppError(
          identity.scrapeStrategy === 'unsupported' ? 'INTERNAL' : 'INVALID_URL',
          identity.reason || 'unrecognized shop URL',
          { shopUrl: req.shopUrl, family: identity.family }
        )
      }
      let merchantId = req.merchantId ?? null
      let baseUrl: string | null = null
      if (!merchantId) {
        const m = this.repos.merchants.findByShopRef(ref.platformId, ref.token)
        if (m) merchantId = m.id
      }
      baseUrl = resolveHostTokenBaseUrl(ref.platformId, {
        host: ref.token,
        shopUrl,
        entryUrl: shopUrl
      })
      return {
        platformId: ref.platformId,
        token: ref.token,
        merchantId,
        label: shopUrl,
        identity,
        baseUrl,
        shopUrl,
        entryUrl: shopUrl
      }
    }

    if (req.token && req.platformId) {
      const identity = identifyShopPlatform({
        shopPlatform: req.platformId,
        shopToken: req.token
      })
      const ref = identityToScrapeRef(identity)
      if (!ref) {
        const m =
          this.repos.merchants.findByShopRef(req.platformId, req.token) ??
          (req.merchantId ? this.repos.merchants.getById(req.merchantId) : null)
        const trial = this.buildUnknownTrialTarget({
          identity,
          merchantId: m?.id ?? req.merchantId ?? null,
          host: m?.host,
          shopUrl: m?.shopUrl,
          entryUrl: m?.entryUrl,
          token: req.token,
          platformId: req.platformId,
          shopName: m?.name ?? null,
          label: m?.name
        })
        if (trial) return trial
        throw new AppError('NOT_FOUND', identity.reason || 'platform not scrapable', {
          platformId: req.platformId,
          family: identity.family
        })
      }
      const m = this.repos.merchants.findByShopRef(ref.platformId, ref.token)
      const baseUrl = resolveHostTokenBaseUrl(ref.platformId, {
        host: ref.token,
        shopUrl: m?.shopUrl,
        entryUrl: m?.entryUrl
      })
      return {
        platformId: ref.platformId,
        token: ref.token,
        merchantId: m?.id ?? req.merchantId ?? null,
        identity,
        baseUrl,
        shopName: m?.name ?? null,
        shopUrl: m?.shopUrl ?? null,
        entryUrl: m?.entryUrl ?? null
      }
    }

    if (req.merchantId) {
      const m = this.repos.merchants.getById(req.merchantId)
      if (!m) throw new AppError('NOT_FOUND', 'merchant not found')
      const identity = identifyShopPlatform({
        host: m.host,
        shopUrl: m.shopUrl,
        entryUrl: m.entryUrl,
        shopPlatform: req.platformId || m.shopPlatform,
        shopToken: req.token || m.shopToken,
        ldxpToken: m.ldxpToken,
        collectorKind: m.collectorKind
      })
      const ref = identityToScrapeRef(identity)
      if (!ref) {
        const trial = this.buildUnknownTrialTarget({
          identity,
          merchantId: m.id,
          host: m.host,
          shopUrl: m.shopUrl,
          entryUrl: m.entryUrl,
          token: req.token || m.shopToken || m.ldxpToken,
          platformId: req.platformId || m.shopPlatform,
          shopName: m.name,
          label: m.name
        })
        if (trial) return trial
        throw new AppError('NOT_FOUND', identity.reason || 'merchant has no scrapable shop ref', {
          merchantId: m.id,
          family: identity.family,
          collectorKind: m.collectorKind
        })
      }
      const baseUrl = resolveHostTokenBaseUrl(ref.platformId, {
        host: ref.token,
        shopUrl: m.shopUrl,
        entryUrl: m.entryUrl
      })
      // Disabled profile still resolves so scraper can return PAUSED.
      return {
        platformId: ref.platformId,
        token: ref.token,
        merchantId: m.id,
        label: m.name,
        identity,
        baseUrl,
        shopName: m.name,
        shopUrl: m.shopUrl,
        entryUrl: m.entryUrl
      }
    }

    // bare token without platform → default ldxp (legacy IPC only)
    if (req.token) {
      const identity = identifyShopPlatform({
        shopPlatform: 'ldxp',
        shopToken: req.token,
        ldxpToken: req.token
      })
      const ref = identityToScrapeRef(identity)
      if (!ref) {
        throw new AppError('NOT_FOUND', identity.reason || 'token not scrapable')
      }
      const m = this.repos.merchants.findByShopRef(ref.platformId, ref.token)
      return {
        platformId: ref.platformId,
        token: ref.token,
        merchantId: m?.id ?? null,
        identity
      }
    }

    return { platformId: '', token: '', merchantId: null }
  }

  /**
   * Build a trial scrape target for unknown / non-scrapable shops.
   * Returns null when there is no host or shop-token material to try.
   */
  private buildUnknownTrialTarget(opts: {
    identity: ReturnType<typeof identifyShopPlatform>
    merchantId: string | null
    host?: string | null
    shopUrl?: string | null
    entryUrl?: string | null
    token?: string | null
    platformId?: string | null
    shopName?: string | null
    label?: string
  }): ShopScrapeTarget | null {
    if (!shouldTrialUnknownPlatform(opts.identity)) return null
    const host =
      (opts.host || '').trim() ||
      (() => {
        for (const raw of [opts.shopUrl, opts.entryUrl]) {
          if (!raw?.trim()) continue
          try {
            const u = new URL(raw.includes('://') ? raw.trim() : `https://${raw.trim()}`)
            if (u.protocol !== 'http:' && u.protocol !== 'https:') continue
            return hostKey(u.hostname)
          } catch {
            /* continue */
          }
        }
        return ''
      })()
    const storedToken = (opts.token || opts.identity.token || '').trim()
    const platformId =
      (opts.platformId || opts.identity.platformId || 'unknown').trim() || 'unknown'
    const token = host || storedToken
    if (
      !canBuildUnknownTrialTarget({
        host: host || null,
        shopUrl: opts.shopUrl,
        entryUrl: opts.entryUrl,
        token: storedToken || host || null,
        platformId
      })
    ) {
      return null
    }
    let baseUrl: string | null = null
    for (const raw of [opts.shopUrl, opts.entryUrl]) {
      if (!raw?.trim()) continue
      try {
        const u = new URL(raw.includes('://') ? raw.trim() : `https://${raw.trim()}`)
        if (u.protocol === 'http:' || u.protocol === 'https:') {
          baseUrl = u.origin
          break
        }
      } catch {
        /* continue */
      }
    }
    if (!baseUrl && host) baseUrl = `https://${host}`
    return {
      platformId,
      token,
      merchantId: opts.merchantId,
      label: opts.label,
      identity: opts.identity,
      baseUrl,
      shopName: opts.shopName ?? null,
      trialUnknownPlatform: true,
      shopUrl: opts.shopUrl ?? null,
      entryUrl: opts.entryUrl ?? null
    }
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
      background?: boolean
    }
  ): Promise<void> {
    enterSyncRequestScope(jobId)
    try {
      const settings = this.repos.settings.get()
      const minInterval = settings.shopMinIntervalMs ?? settings.ldxpMinIntervalMs
      const enabledIds = enabledScrapablePlatformIds()

      const priceaiIntervalMs = RATE_LIMITS.priceaiMerchantsIntervalMs.default
      if (jobType === 'merchants') {
        const client = new PriceaiClient({ userAgent: settings.priceaiUa })
        await this.runMerchants(jobId, signal, client, priceaiIntervalMs)
      } else if (jobType === 'bootstrap') {
        const client = new PriceaiClient({ userAgent: settings.priceaiUa })
        const merchants = await this.fetchMerchantsPhase(
          jobId,
          'bootstrap',
          signal,
          client,
          priceaiIntervalMs
        )
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
          targets.map((m) => this.resolveShopTarget({ merchantId: m.id })),
          minInterval,
          { extraMeta: { merchantsUpserted: merchants.rows.length } }
        )
      } else if (jobType === 'shop_one') {
        const target = this.resolveShopTarget(ctx)
        if (target.merchantId && this.repos.merchants.isMerchantBlocked(target.merchantId)) {
          throw new AppError('NOT_FOUND', 'merchant is blocked')
        }
        await this.runShopQueue(jobId, jobType, signal, [target], minInterval, {
          background: ctx.background === true
        })
      } else if (jobType === 'shop_selected') {
        // Unknown-platform trial targets use platformId "unknown" (or other unregistered ids)
        // and must not be dropped by enabledIds — they try known modes at scrape time.
        const targets = (ctx.merchantIds ?? [])
          .filter((id) => !this.repos.merchants.isMerchantBlocked(id))
          .map((id) => {
            try {
              return this.resolveShopTarget({ merchantId: id })
            } catch {
              return null
            }
          })
          .filter((t): t is ShopScrapeTarget => isSelectableShopTarget(t, enabledIds))
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
          .map((m) => this.resolveShopTarget({ merchantId: m.id }))
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
    } finally {
      leaveSyncRequestScope(jobId)
    }
  }

  private async fetchMerchantsPhase(
    jobId: string,
    jobType: SyncJobType,
    signal: AbortSignal,
    client: PriceaiClient,
    intervalMs: number
  ): Promise<
    Awaited<ReturnType<typeof fetchAllMerchants>> & {
      deletedNoLink: number
      fingerprintMatched: number
      fingerprintRejected: number
      nodebitsUpserted: number
      nodebitsDroppedNoLink: number
      nodebitsShopsFetched: number
    }
  > {
    const settings = this.repos.settings.get()
    // Stream to DB as each page/shop becomes ready — do not wait until the full pull ends.
    let priceaiUpserted = 0
    const result = await fetchAllMerchants({
      client,
      intervalMs,
      signal,
      userAgent: settings.priceaiUa,
      onMerchantsReady: (rows) => {
        priceaiUpserted += this.repos.merchants.upsertMany(rows)
      },
      onProgress: (p) =>
        this.progress(
          jobId,
          jobType,
          'merchants',
          p.current,
          p.total,
          p.phase === 'resolve' ? '商品链接转店铺' : `PriceAI page ${p.page}`
        )
    })
    log.info('priceai merchants streamed', {
      rows: result.rows.length,
      upserted: priceaiUpserted,
      pages: result.pages,
      droppedNoLink: result.droppedNoLink
    })

    // Second merchant-list source only. Product scrape + platform id stay global
    // (registry / identifyShopPlatform), same as merchants that came from PriceAI.
    const nodebitsClient = new NodebitsClient({ userAgent: settings.priceaiUa })
    let nodebitsUpserted = 0
    let nodebitsDroppedNoLink = 0
    let nodebitsShopsFetched = 0
    try {
      const nb = await fetchAllNodebitsMerchants({
        client: nodebitsClient,
        intervalMs,
        signal,
        userAgent: settings.priceaiUa,
        onMerchantsReady: (rows) => {
          nodebitsUpserted += this.repos.merchants.upsertMany(rows)
        },
        onProgress: (p) => {
          const label =
            p.phase === 'shops'
              ? 'NodeBits 店铺列表'
              : p.phase === 'go'
                ? 'NodeBits 中转页取店址'
                : p.phase === 'resolve'
                  ? '商品链接转店铺'
                  : 'NodeBits 归一化'
          this.progress(jobId, jobType, 'merchants', p.current, p.total, label)
        }
      })
      nodebitsDroppedNoLink = nb.droppedNoLink
      nodebitsShopsFetched = nb.shopsFetched
      log.info('nodebits merchants streamed', {
        rows: nb.rows.length,
        upserted: nodebitsUpserted,
        shopsFetched: nb.shopsFetched,
        goResolved: nb.goResolved,
        goFailed: nb.goFailed,
        droppedNoLink: nb.droppedNoLink,
        droppedItemUnresolved: nb.droppedItemUnresolved,
        resolvedFromItem: nb.resolvedFromItem,
        droppedTest: nb.droppedTest
      })
    } catch (err) {
      // PriceAI is primary; NodeBits failure should not wipe a successful PriceAI pull.
      if (err instanceof AppError && err.code === 'CANCELLED') throw err
      log.warn('nodebits merchants fetch failed (continuing with PriceAI only)', {
        error: err instanceof Error ? err.message : String(err)
      })
    }

    const deletedNoLink = this.repos.merchants.deleteWithoutExternalLinks()
    const fp = await this.probeYiciyuanCandidates(jobId, jobType, signal, intervalMs)
    return {
      ...result,
      // total kept for progress: PriceAI unique + NodeBits kept
      rows: result.rows,
      deletedNoLink,
      nodebitsUpserted,
      nodebitsDroppedNoLink,
      nodebitsShopsFetched,
      ...fp
    }
  }

  /**
   * Live-probe kami/yiciyuan candidates missing a confirmed scrapable ref.
   * Match → write shop_platform=yiciyuan; not_family → leave without ref.
   * Different hosts probe in parallel; same host shares the process host limiter.
   */
  private async probeYiciyuanCandidates(
    jobId: string,
    jobType: SyncJobType,
    signal: AbortSignal,
    intervalMs: number
  ): Promise<{ fingerprintMatched: number; fingerprintRejected: number }> {
    const candidates = this.repos.merchants.listYiciyuanProbeCandidates(40)
    if (!candidates.length) {
      return { fingerprintMatched: 0, fingerprintRejected: 0 }
    }
    const gap = Math.max(intervalMs, 400)
    let matched = 0
    let rejected = 0
    let done = 0
    await mapWithConcurrency(
      candidates,
      RATE_LIMITS.maxHostParallel,
      async (c) => {
        if (signal.aborted) throw new AppError('CANCELLED', 'cancelled')
        try {
          await getHostLimiter(gap).waitTurn(hostKey(c.host), signal)
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') {
            throw new AppError('CANCELLED', 'cancelled')
          }
          throw err
        }
        if (signal.aborted) throw new AppError('CANCELLED', 'cancelled')
        try {
          const result = await probeYiciyuan({
            host: c.host,
            shopUrl: c.shopUrl,
            entryUrl: c.entryUrl
          })
          if (result.kind === 'match') {
            this.repos.merchants.setShopRef(c.id, YICIYUAN_PLATFORM_ID, c.host.toLowerCase())
            matched += 1
          } else if (result.kind === 'not_family') {
            rejected += 1
            log.info('yiciyuan probe rejected', { host: c.host, message: result.message })
          } else {
            log.info('yiciyuan probe network', { host: c.host, message: result.message })
          }
        } catch (err) {
          log.warn('yiciyuan probe error', {
            host: c.host,
            err: err instanceof Error ? err.message : String(err)
          })
        }
        done += 1
        this.progress(
          jobId,
          jobType,
          'fingerprint',
          done,
          candidates.length,
          `probe yiciyuan ${c.host} (${done}/${candidates.length})`
        )
      },
      signal
    )
    this.progress(
      jobId,
      jobType,
      'fingerprint',
      candidates.length,
      candidates.length,
      `fingerprint matched ${matched}, rejected ${rejected}`
    )
    return { fingerprintMatched: matched, fingerprintRejected: rejected }
  }

  private async runMerchants(
    jobId: string,
    signal: AbortSignal,
    client: PriceaiClient,
    intervalMs: number
  ): Promise<void> {
    const result = await this.fetchMerchantsPhase(jobId, 'merchants', signal, client, intervalMs)
    const totalUpserted = result.rows.length + result.nodebitsUpserted
    this.finishSuccess(
      jobId,
      'merchants',
      'merchants',
      totalUpserted,
      result.total + result.nodebitsShopsFetched,
      `upserted ${totalUpserted} (PriceAI ${result.rows.length}, NodeBits ${result.nodebitsUpserted}), dropped no-link ${result.droppedNoLink + result.nodebitsDroppedNoLink}, deleted stale ${result.deletedNoLink}, fingerprint +${result.fingerprintMatched}/-${result.fingerprintRejected}`,
      {
        pages: result.pages,
        generatedAt: result.generatedAt,
        fetchedUnique: result.fetchedUnique,
        droppedNoLink: result.droppedNoLink,
        droppedItemUnresolved: result.droppedItemUnresolved,
        resolvedFromItem: result.resolvedFromItem,
        deletedNoLink: result.deletedNoLink,
        fingerprintMatched: result.fingerprintMatched,
        fingerprintRejected: result.fingerprintRejected,
        nodebitsUpserted: result.nodebitsUpserted,
        nodebitsDroppedNoLink: result.nodebitsDroppedNoLink,
        nodebitsShopsFetched: result.nodebitsShopsFetched
      }
    )
  }

  /**
   * Product scrape queue.
   * Targets are grouped by host: up to maxHostParallel host groups run in parallel;
   * shops within the same host run sequentially (HTTP still spaced by host limiter).
   */
  private async runShopQueue(
    jobId: string,
    jobType: SyncJobType,
    signal: AbortSignal,
    targets: ShopScrapeTarget[],
    minIntervalMs: number,
    opts?: {
      skippedFresh?: number
      extraMeta?: Record<string, unknown>
      /** kept for API compat; simulated browser path has no interactive WAF window */
      background?: boolean
    }
  ): Promise<void> {
    let done = 0
    let failed = 0
    let skippedUnknown = 0
    const errors: {
      merchantId: string | null
      platformId: string
      token: string
      message: string
      code?: string
      details?: unknown
    }[] = []
    const total = targets.length
    const pageConcurrency = 1

    try {
      await runHostGroupedQueue(
        targets,
        RATE_LIMITS.maxHostParallel,
        async (target) => {
          if (signal.aborted) throw new AppError('CANCELLED', 'cancelled')
          if (target.merchantId) {
            this.repos.merchants.setAppHealth(target.merchantId, 'retrying')
          } else {
            this.repos.merchants.setAppHealthByShopRef(target.platformId, target.token, 'retrying')
          }
          this.progress(
            jobId,
            jobType,
            'shop',
            done,
            total,
            `scraping ${target.platformId}:${target.token} (${done + 1}/${total})`
          )
          try {
            const result = await scrapeShopTarget({
              target,
              minIntervalMs,
              pageConcurrency,
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
            const platformId = result.discoveredRef?.platformId ?? target.platformId
            const token = result.discoveredRef?.token ?? target.token
            const source =
              result.rows[0]?.source ??
              findProfileById(platformId, SHOP_PROFILES)?.sourceId ??
              platformId
            this.repos.shopProducts.replaceForShop(source, token, result.rows)
            if (target.merchantId) {
              if (result.discoveredRef) {
                this.repos.merchants.setShopRef(
                  target.merchantId,
                  result.discoveredRef.platformId,
                  result.discoveredRef.token
                )
              }
              this.repos.merchants.setAppHealth(target.merchantId, 'healthy')
              this.repos.merchants.relinkShopProducts(platformId, token, target.merchantId)
            } else {
              this.repos.merchants.setAppHealthByShopRef(platformId, token, 'healthy')
            }
            done += 1
            this.progress(
              jobId,
              jobType,
              'shop',
              done,
              total,
              `ok ${platformId}:${token} (${done}/${total})`
            )
          } catch (err) {
            if (err instanceof AppError && err.code === 'CANCELLED') throw err
            if (err instanceof Error && err.name === 'AbortError') {
              throw new AppError('CANCELLED', 'cancelled')
            }
            // Unknown-platform all-modes-failed: silent skip (no failing health, no blocklist)
            // Does not count as a successful scrape — no empty "synced" claim.
            if (isSilentUnknownFailure(err)) {
              done += 1
              skippedUnknown += 1
              if (target.merchantId) {
                this.repos.merchants.setAppHealth(target.merchantId, 'never', null)
              }
              this.progress(
                jobId,
                jobType,
                'shop',
                done,
                total,
                `skip-unknown ${target.platformId}:${target.token} (${done}/${total})`
              )
              log.info('unknown platform trial silent skip', {
                merchantId: target.merchantId,
                platformId: target.platformId,
                token: target.token
              })
              return
            }
            failed += 1
            done += 1
            const rawMessage = err instanceof Error ? err.message : String(err)
            const code = err instanceof AppError ? err.code : 'INTERNAL'
            const details = err instanceof AppError ? err.details : undefined
            const message = formatErrorWithDetails(rawMessage, details)
            const notFamily =
              err instanceof AppError &&
              err.code === 'SCHEMA_VALIDATION' &&
              !!(err.details as { notFamily?: boolean } | undefined)?.notFamily
            errors.push({
              merchantId: target.merchantId,
              platformId: target.platformId,
              token: target.token,
              message: notFamily ? `指纹不符: ${message}` : message,
              code,
              details
            })
            if (notFamily && target.merchantId) {
              this.repos.merchants.clearShopRef(target.merchantId)
            } else if (target.merchantId) {
              this.repos.merchants.setAppHealth(target.merchantId, 'failing', message)
            } else if (!notFamily) {
              this.repos.merchants.setAppHealthByShopRef(
                target.platformId,
                target.token,
                'failing',
                message
              )
            }
            if (
              target.merchantId &&
              shouldBlockMerchantAfterSyncFailure({
                enabled: this.repos.settings.get().blockOnShopSyncFail,
                code,
                notFamily,
                merchantId: target.merchantId
              })
            ) {
              const m = this.repos.merchants.getById(target.merchantId)
              this.repos.blocklist.add({
                targetType: 'merchant',
                targetId: target.merchantId,
                titleSnapshot: m?.name ?? `${target.platformId}:${target.token}`
              })
              log.info('auto-blocked merchant after shop sync fail', {
                merchantId: target.merchantId,
                platformId: target.platformId,
                token: target.token,
                code
              })
            }
            this.progress(
              jobId,
              jobType,
              'shop',
              done,
              total,
              `${notFamily ? 'not-family' : 'fail'} ${target.platformId}:${target.token} (${done}/${total})`
            )
            log.warn('shop scrape failed', {
              platformId: target.platformId,
              token: target.token,
              code,
              message,
              notFamily,
              details
            })
          }
        },
        signal
      )
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AppError('CANCELLED', 'cancelled')
      }
      throw err
    }

    const skippedFresh = opts?.skippedFresh ?? 0
    const ok = total - failed - skippedUnknown
    const parts: string[] = []
    if (ok > 0) parts.push(`synced ${ok}/${total} shops`)
    if (failed > 0) parts.push(`${failed} failed`)
    if (skippedUnknown > 0) parts.push(`${skippedUnknown} unknown-skip`)
    if (skippedFresh > 0) parts.push(`skipped ${skippedFresh} fresh`)
    if (!parts.length) parts.push(total === 0 ? 'no shops' : 'synced 0 shops')
    const statusMessage = parts.join(', ')
    const finishedAt = new Date().toISOString()
    // Pure silent-unknown (no data written) is not success.
    const finalStatus =
      ok > 0 && failed === 0 && skippedUnknown === 0
        ? 'succeeded'
        : ok > 0
          ? 'partial'
          : 'failed'
    const jobErrorCode =
      failed || (ok === 0 && skippedUnknown > 0)
        ? primaryErrorCode(errors) || (skippedUnknown > 0 ? 'NOT_FOUND' : null)
        : null
    this.repos.syncJobs.update(jobId, {
      status: finalStatus,
      phase: 'done',
      current: total,
      total,
      message: statusMessage,
      errorCode: jobErrorCode,
      finishedAt,
      meta: {
        errors: errors.slice(0, 50),
        failed,
        ok,
        skippedUnknown,
        skippedFresh,
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
      errorCode: jobErrorCode ?? undefined
    })
    log.info('shop queue finished', {
      jobId,
      jobType,
      total,
      failed,
      skippedUnknown,
      ok
    })
  }

  private progress(
    jobId: string,
    jobType: SyncJobType,
    phase: string,
    current: number,
    total: number,
    message: string
  ): void {
    const prev = this.repos.syncJobs.get(jobId)
    if (prev && ['succeeded', 'failed', 'partial', 'cancelled'].includes(prev.status)) {
      return
    }
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
    const prev = this.repos.syncJobs.get(jobId)
    // cancel() already terminalized the job — do not overwrite with success
    if (prev && ['cancelled', 'failed', 'partial', 'succeeded'].includes(prev.status)) {
      if (prev.status !== 'succeeded') {
        log.info('sync success ignored; job already terminal', {
          jobId,
          jobType,
          status: prev.status
        })
        return
      }
    }
    const finishedAt = new Date().toISOString()
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
    const prev = this.repos.syncJobs.get(jobId)
    // cancel() already wrote cancelled + notified; skip double notify
    if (prev?.status === 'cancelled' && code === 'CANCELLED') {
      log.info('sync cancel already applied', { jobId, jobType })
      return
    }
    if (prev && ['succeeded', 'failed', 'partial', 'cancelled'].includes(prev.status)) {
      log.info('sync error ignored; job already terminal', {
        jobId,
        jobType,
        status: prev.status,
        code
      })
      return
    }
    const finishedAt = new Date().toISOString()
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
      requestedJobType: event.requestedJobType ?? running?.requestedJobType,
      background: event.background ?? running?.background
    }
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_CHANNELS.syncProgress, payload)
    }
    this.maybeNotifyFinished(payload)
  }

  private maybeNotifyFinished(event: SyncProgressEvent): void {
    if (!['succeeded', 'failed', 'partial', 'cancelled'].includes(event.status)) return
    // Background auto-refresh should not spam desktop notifications
    if (event.background) return
    const settings = this.repos.settings.get()
    if (!settings.notifyOnJobFinished) return
    if (!Notification.isSupported()) return
    const statusLabel =
      event.status === 'succeeded'
        ? '完成'
        : event.status === 'partial'
          ? '部分完成'
          : event.status === 'cancelled'
            ? '已取消'
            : '失败'
    const body = [event.message, event.errorCode ? `错误: ${event.errorCode}` : '']
      .filter(Boolean)
      .join(' · ')
    try {
      new Notification({
        title: `${APP_NAME} · 同步${statusLabel}`,
        body: body || event.jobType
      }).show()
    } catch (err) {
      log.warn('desktop notification failed', {
        err: err instanceof Error ? err.message : String(err)
      })
    }
  }
}
