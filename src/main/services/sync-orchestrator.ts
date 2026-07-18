import { randomUUID } from 'node:crypto'
import { BrowserWindow, Notification } from 'electron'
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
import { APP_NAME, BOOTSTRAP_TOP_N, PROXY_NODE_RETRY } from '@shared/constants'
import {
  DUJIAO_PLATFORM_ID,
  YICIYUAN_PLATFORM_ID,
  identifyShopPlatform,
  identityToScrapeRef
} from '@shared/platforms/identify'
import { enabledScrapablePlatformIds, SHOP_PROFILES } from '@shared/platforms/shop-profiles'
import { findProfileById } from '@shared/platforms/shop-types'
import { activeProxySubscriptions } from '@shared/types/proxy-subscription'
import { resolveDujiaoBaseUrl } from '../platforms/dujiao/client'
import { resolveYiciyuanBaseUrl } from '../platforms/yiciyuan/client'
import { probeYiciyuan } from '../platforms/fingerprint/probe'
import { IntervalLimiter } from './rate-limiter'
import { isNodeRetryableError, nodeRetryMaxCandidates, pickCandidateNodes } from './node-retry'
import {
  pruneNodeScores,
  recordAttemptFailure,
  recordAttemptSuccess,
  recordWafHit
} from './node-score'
import { shouldBlockMerchantAfterSyncFailure } from './sync-failure-policy'
import { getProxyCoreService } from './proxy-core-service'
import { enterSyncRequestScope, leaveSyncRequestScope } from './sync-request-log'
import type { Repositories } from '../db/repositories'
import { createLogger } from '../utils/logger'
import { fetchAllMerchants } from '../platforms/priceai/fetcher-merchants'
import { PriceaiClient } from '../platforms/priceai/client'
import { scrapeShopTarget, type ShopScrapeTarget } from '../platforms/registry'

const log = createLogger('sync')

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
    if (!jobType) {
      throw new AppError('INTERNAL', `unknown job type ${String(req.jobType)}`, {
        jobType: req.jobType
      })
    }

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
      if (target.platformId === DUJIAO_PLATFORM_ID) {
        // host-as-token family; always enabled when resolved
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
        background: req.background === true
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
      force: req.force,
      background: req.background === true
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
        baseUrl
      }
    }

    if (req.token && req.platformId) {
      const identity = identifyShopPlatform({
        shopPlatform: req.platformId,
        shopToken: req.token
      })
      const ref = identityToScrapeRef(identity)
      if (!ref) {
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
        shopName: m?.name ?? null
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
        shopName: m.name
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
        const targets = (ctx.merchantIds ?? [])
          .filter((id) => !this.repos.merchants.isMerchantBlocked(id))
          .map((id) => {
            try {
              return this.resolveShopTarget({ merchantId: id })
            } catch {
              return null
            }
          })
          .filter((t): t is ShopScrapeTarget => !!t && !!t.token && !!t.platformId)
          .filter((t) => enabledIds.includes(t.platformId))
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
    }
  > {
    const result = await fetchAllMerchants({
      client,
      intervalMs,
      signal,
      onProgress: (p) =>
        this.progress(jobId, jobType, 'merchants', p.current, p.total, `page ${p.page}`)
    })
    this.repos.merchants.upsertMany(result.rows)
    const deletedNoLink = this.repos.merchants.deleteWithoutExternalLinks()
    const fp = await this.probeYiciyuanCandidates(jobId, jobType, signal, intervalMs)
    return { ...result, deletedNoLink, ...fp }
  }

  /**
   * Live-probe kami/yiciyuan candidates missing a confirmed scrapable ref.
   * Match → write shop_platform=yiciyuan; not_family → leave without ref.
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
    const limiter = new IntervalLimiter(Math.max(intervalMs, 400))
    let matched = 0
    let rejected = 0
    for (let i = 0; i < candidates.length; i += 1) {
      if (signal.aborted) throw new AppError('CANCELLED', 'cancelled')
      const c = candidates[i]!
      this.progress(
        jobId,
        jobType,
        'fingerprint',
        i,
        candidates.length,
        `probe yiciyuan ${c.host} (${i + 1}/${candidates.length})`
      )
      await limiter.waitTurn()
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
    }
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
    this.finishSuccess(
      jobId,
      'merchants',
      'merchants',
      result.rows.length,
      result.total,
      `upserted ${result.rows.length}, dropped no-link ${result.droppedNoLink}, deleted stale ${result.deletedNoLink}, fingerprint +${result.fingerprintMatched}/-${result.fingerprintRejected}`,
      {
        pages: result.pages,
        generatedAt: result.generatedAt,
        fetchedUnique: result.fetchedUnique,
        droppedNoLink: result.droppedNoLink,
        deletedNoLink: result.deletedNoLink,
        fingerprintMatched: result.fingerprintMatched,
        fingerprintRejected: result.fingerprintRejected
      }
    )
  }

  private async runShopQueue(
    jobId: string,
    jobType: SyncJobType,
    signal: AbortSignal,
    targets: ShopScrapeTarget[],
    minIntervalMs: number,
    opts?: {
      skippedFresh?: number
      extraMeta?: Record<string, unknown>
      /** 后台自动刷新：不打开系统浏览器、WAF 不延后重试 */
      background?: boolean
    }
  ): Promise<void> {
    let done = 0
    let failed = 0
    let ok = 0
    const errors: {
      merchantId: string | null
      platformId: string
      token: string
      message: string
      code?: string
      details?: unknown
    }[] = []
    const total = targets.length
    const settings = this.repos.settings.get()
    const pageConcurrency = settings.shopPageConcurrency
    const background = opts?.background === true
    const openSystemBrowserOnWaf =
      !background &&
      !(settings.proxyCoreEnabled && activeProxySubscriptions(settings.proxySubscriptions).length > 0)
    /** First-pass WAF hits — retry once after the rest of the queue (manual only) */
    const wafDeferred: ShopScrapeTarget[] = []

    const markFail = (
      target: ShopScrapeTarget,
      err: unknown,
      label: string
    ): void => {
      failed += 1
      done += 1
      const message = err instanceof Error ? err.message : String(err)
      const code = err instanceof AppError ? err.code : 'INTERNAL'
      const details = err instanceof AppError ? err.details : undefined
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
        `${label} ${target.platformId}:${target.token} (${done}/${total})`
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

    const markOk = (
      target: ShopScrapeTarget,
      result: Awaited<ReturnType<typeof scrapeShopTarget>>
    ): void => {
      const source =
        result.rows[0]?.source ??
        findProfileById(target.platformId, SHOP_PROFILES)?.sourceId ??
        target.platformId
      this.repos.shopProducts.replaceForShop(source, target.token, result.rows)
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
      ok += 1
      done += 1
      this.progress(
        jobId,
        jobType,
        'shop',
        done,
        total,
        `ok ${target.platformId}:${target.token} (${done}/${total})`
      )
    }

    /**
     * 失败换节点策略：pin 一个未标记的节点整店重试（最多 maxNodes 个）。
     * 后续节点成功 ⇒ 之前失败的节点确证为该平台不可用（持久化，TTL 过期）。
     * 全部失败 ⇒ 不标记任何节点（分不清是节点坏还是链接坏），由调用方屏蔽商家。
     * pin 是全局的（共享 mixed-port）——shop lane 串行所以安全；并行的
     * priceai lane 流量会短暂跟随被测节点，窗口小，可接受。
     */
    const rotateNodesAndRetry = async (
      target: ShopScrapeTarget,
      firstError: unknown,
      attempt: () => ReturnType<typeof scrapeShopTarget>
    ): Promise<
      | { outcome: 'ok'; result: Awaited<ReturnType<typeof scrapeShopTarget>> }
      | { outcome: 'fail'; finalError: unknown }
    > => {
      const core = getProxyCoreService()
      if (
        !isNodeRetryableError(firstError) ||
        !core ||
        core.status().state !== 'running'
      ) {
        return { outcome: 'fail', finalError: firstError }
      }
      let nodes: Array<{ name: string; delay?: number }> = []
      let listNodesOk = false
      try {
        nodes = await core.listNodes()
        listNodesOk = true
      } catch (e) {
        log.warn('listNodes failed, skip node rotation', { err: String(e) })
      }
      const delayByName = new Map<string, number | undefined>()
      const knownNames = new Set<string>()
      for (const n of nodes) {
        const name = n.name.trim()
        if (!name) continue
        knownNames.add(name)
        delayByName.set(name, n.delay)
      }
      // 仅在 listNodes 成功时 prune；失败时 known 为空，若 prune 会误清空全部分数
      if (listNodesOk) pruneNodeScores(knownNames)
      const badNames = this.repos.platformBadNodes.activeNodeNames(target.platformId)
      const candidates = pickCandidateNodes(
        nodes,
        badNames,
        nodeRetryMaxCandidates(firstError)
      )
      if (!candidates.length) {
        return { outcome: 'fail', finalError: firstError }
      }
      log.debug('node rotation candidates', {
        platformId: target.platformId,
        token: target.token,
        candidates,
        delays: candidates.map((c) => ({ name: c, delay: delayByName.get(c) }))
      })

      const failedNodes: string[] = []
      let lastError: unknown = firstError
      try {
        for (const node of candidates) {
          if (signal.aborted) throw new AppError('CANCELLED', 'cancelled')
          try {
            await core.pinNode(node)
          } catch (e) {
            log.warn('pinNode failed, abort rotation', { node, err: String(e) })
            break
          }
          this.progress(
            jobId,
            jobType,
            'shop',
            done,
            total,
            `node-retry ${target.platformId}:${target.token} via ${node}`
          )
          try {
            const result = await attempt()
            recordAttemptSuccess(node, { delay: delayByName.get(node) })
            for (const badNode of failedNodes) {
              this.repos.platformBadNodes.add({
                platformId: target.platformId,
                nodeName: badNode,
                reason: `换节点后成功（${node}），此节点失败`,
                ttlMs: PROXY_NODE_RETRY.badNodeTtlHours * 3_600_000
              })
            }
            log.info('node rotation succeeded', {
              platformId: target.platformId,
              token: target.token,
              node,
              markedBad: failedNodes
            })
            return { outcome: 'ok', result }
          } catch (err) {
            if (err instanceof AppError && err.code === 'CANCELLED') throw err
            lastError = err
            if (!isNodeRetryableError(err)) {
              // structural failure — node not to blame, stop rotating
              return { outcome: 'fail', finalError: err }
            }
            if (err instanceof AppError && err.code === 'NEED_BROWSER') {
              recordWafHit(node)
            } else if (
              err instanceof AppError &&
              (err.code === 'NETWORK' || err.code === 'TIMEOUT')
            ) {
              recordAttemptFailure(node)
            }
            failedNodes.push(node)
            log.info('node retry failed', {
              platformId: target.platformId,
              token: target.token,
              node,
              code: err instanceof AppError ? err.code : 'INTERNAL'
            })
          }
        }
      } finally {
        try {
          await core.unpinNode()
        } catch (e) {
          log.warn('unpinNode failed', { err: String(e) })
        }
      }
      return { outcome: 'fail', finalError: lastError }
    }

    const scrapeOne = async (target: ShopScrapeTarget): Promise<'ok' | 'waf' | 'fail'> => {
      if (signal.aborted) throw new AppError('CANCELLED', 'cancelled')
      if (target.merchantId) {
        this.repos.merchants.setAppHealth(target.merchantId, 'retrying')
      } else {
        this.repos.merchants.setAppHealthByShopRef(target.platformId, target.token, 'retrying')
      }
      const attempt = (): ReturnType<typeof scrapeShopTarget> =>
        scrapeShopTarget({
          target,
          minIntervalMs,
          pageConcurrency,
          signal,
          openSystemBrowserOnWaf,
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
      try {
        const result = await attempt()
        if (signal.aborted) throw new AppError('CANCELLED', 'cancelled')
        markOk(target, result)
        return 'ok'
      } catch (err) {
        if (err instanceof AppError && err.code === 'CANCELLED') throw err

        const rotation = await rotateNodesAndRetry(target, err, attempt)
        if (rotation.outcome === 'ok') {
          if (signal.aborted) throw new AppError('CANCELLED', 'cancelled')
          markOk(target, rotation.result)
          return 'ok'
        }
        const finalError = rotation.finalError
        if (finalError instanceof AppError && finalError.code === 'NEED_BROWSER') {
          return 'waf'
        }
        markFail(target, finalError, 'fail')
        return 'fail'
      }
    }

    // Pass 1: scrape all; WAF → defer (manual: system browser may have opened)
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]!
      this.progress(
        jobId,
        jobType,
        'shop',
        done,
        total,
        `scraping ${target.platformId}:${target.token} (${i + 1}/${total})`
      )
      const outcome = await scrapeOne(target)
      if (outcome === 'waf') {
        if (background) {
          // 后台不同浏览器、不延后重试；标 failing 后自动池会排除
          markFail(
            target,
            new AppError('NEED_BROWSER', '人机验证未通过（后台同步已跳过，请手动同步）', {
              platformId: target.platformId,
              token: target.token,
              background: true
            }),
            'waf-bg-skip'
          )
          continue
        }
        wafDeferred.push(target)
        if (target.merchantId) {
          this.repos.merchants.setAppHealth(
            target.merchantId,
            'retrying',
            '人机验证：已开系统浏览器，本批末尾再试一次'
          )
        }
        this.progress(
          jobId,
          jobType,
          'shop',
          done,
          total,
          `waf-defer ${target.platformId}:${target.token} (pending ${wafDeferred.length})`
        )
        log.info('shop WAF deferred', {
          platformId: target.platformId,
          token: target.token,
          deferred: wafDeferred.length
        })
      }
    }

    // Pass 2: one retry for deferred WAF shops (no further defer)
    if (wafDeferred.length && !signal.aborted) {
      this.progress(
        jobId,
        jobType,
        'shop',
        done,
        total,
        `retrying ${wafDeferred.length} WAF-deferred shops`
      )
      log.info('WAF retry pass', { count: wafDeferred.length })
      for (const target of wafDeferred) {
        if (signal.aborted) throw new AppError('CANCELLED', 'cancelled')
        this.progress(
          jobId,
          jobType,
          'shop',
          done,
          total,
          `waf-retry ${target.platformId}:${target.token}`
        )
        const outcome = await scrapeOne(target)
        if (outcome === 'waf') {
          markFail(
            target,
            new AppError('NEED_BROWSER', '人机验证仍未通过（已重试一次）', {
              platformId: target.platformId,
              token: target.token
            }),
            'waf-fail'
          )
        }
      }
    }

    if (signal.aborted) throw new AppError('CANCELLED', 'cancelled')
    const existing = this.repos.syncJobs.get(jobId)
    if (existing && ['succeeded', 'failed', 'partial', 'cancelled'].includes(existing.status)) {
      return
    }

    const skippedNote = opts?.skippedFresh ? `, skipped ${opts.skippedFresh} fresh` : ''
    const wafNote = wafDeferred.length ? `, wafDeferred ${wafDeferred.length}` : ''
    const statusMessage =
      (failed === 0
        ? `synced ${ok} shops`
        : `synced ${ok}/${total} shops, ${failed} failed`) +
      skippedNote +
      wafNote
    const finishedAt = new Date().toISOString()
    const finalStatus = failed === 0 ? 'succeeded' : ok === 0 ? 'failed' : 'partial'
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
        ok,
        wafDeferred: wafDeferred.length,
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
      requestedJobType: event.requestedJobType ?? running?.requestedJobType
    }
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_CHANNELS.syncProgress, payload)
    }
    this.maybeNotifyFinished(payload)
  }

  private maybeNotifyFinished(event: SyncProgressEvent): void {
    if (!['succeeded', 'failed', 'partial', 'cancelled'].includes(event.status)) return
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
