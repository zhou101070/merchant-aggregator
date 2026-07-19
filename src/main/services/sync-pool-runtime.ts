import { randomUUID } from 'node:crypto'
import type {
  GroupPoolStatus,
  JobPoolSnapshot,
  MerchantPoolItem,
  MerchantPoolStatus,
  ProductGroupPoolItem
} from '@shared/types/sync'
import type { ShopScrapeTarget } from '../platforms/registry'
import type { NormalizedShopProductRow } from '../db/repositories/shop-products-repo'
import type { ShopApiScrapeSession } from '../platforms/shopapi/session'

export function storeKeyOf(platformId: string, token: string): string {
  return `${platformId}\0${token}`
}

export interface ShopAccumulator {
  target: ShopScrapeTarget
  merchantPoolItemId: string
  expectedGroups: number
  expectedFinal: boolean
  doneGroups: number
  rows: NormalizedShopProductRow[]
  groupErrors: {
    groupKey: string
    message: string
    code?: string
    details?: unknown
  }[]
  committed: boolean
  wafPass2: boolean
}

export type StoreSession =
  | { kind: 'shopapi'; session: ShopApiScrapeSession }
  | { kind: 'monolith' }

export class SyncPoolRuntime {
  readonly merchants: MerchantPoolItem[] = []
  readonly groups: ProductGroupPoolItem[] = []
  readonly accumulators = new Map<string, ShopAccumulator>()
  readonly sessions = new Map<string, StoreSession>()
  /** merchantPoolItemId → target */
  readonly targetsByMerchantItem = new Map<string, ShopScrapeTarget>()

  consumeStarted = false
  finished = false

  private snapshotDirty = false
  private lastEmitAt = 0
  private readonly emitMinMs = 250

  constructor(
    readonly jobId: string,
    readonly caps: JobPoolSnapshot['caps'],
    private readonly onSnapshot: (s: JobPoolSnapshot) => void
  ) {}

  enqueueMerchants(targets: ShopScrapeTarget[]): void {
    for (const t of targets) {
      const id = randomUUID()
      this.merchants.push({
        id,
        jobId: this.jobId,
        merchantId: t.merchantId,
        platformId: t.platformId,
        token: t.token,
        status: 'queued'
      })
      this.targetsByMerchantItem.set(id, t)
      this.accumulators.set(storeKeyOf(t.platformId, t.token), {
        target: t,
        merchantPoolItemId: id,
        expectedGroups: 0,
        expectedFinal: false,
        doneGroups: 0,
        rows: [],
        groupErrors: [],
        committed: false,
        wafPass2: false
      })
    }
    this.markDirty()
  }

  snapshot(): JobPoolSnapshot {
    return {
      jobId: this.jobId,
      merchants: this.merchants.map((m) => ({ ...m })),
      groups: this.groups.map((g) => ({ ...g })),
      caps: { ...this.caps }
    }
  }

  markDirty(): void {
    this.snapshotDirty = true
    this.maybeEmit(false)
  }

  flushSnapshot(force = true): void {
    this.maybeEmit(force)
  }

  private maybeEmit(force: boolean): void {
    if (!this.snapshotDirty && !force) return
    const now = Date.now()
    if (!force && now - this.lastEmitAt < this.emitMinMs) return
    this.snapshotDirty = false
    this.lastEmitAt = now
    this.onSnapshot(this.snapshot())
  }

  setMerchant(
    id: string,
    patch: Partial<Pick<MerchantPoolItem, 'status' | 'message' | 'groupCount' | 'startedAt' | 'endedAt'>>
  ): void {
    const m = this.merchants.find((x) => x.id === id)
    if (!m) return
    Object.assign(m, patch)
    this.markDirty()
  }

  setGroup(
    id: string,
    patch: Partial<
      Pick<ProductGroupPoolItem, 'status' | 'message' | 'productCount' | 'startedAt' | 'endedAt'>
    >
  ): void {
    const g = this.groups.find((x) => x.id === id)
    if (!g) return
    Object.assign(g, patch)
    this.markDirty()
  }

  /** Atomic: finalize expected + enqueue all groups */
  finalizeDiscover(merchantItemId: string, groupKeys: string[]): void {
    const m = this.merchants.find((x) => x.id === merchantItemId)
    const target = this.targetsByMerchantItem.get(merchantItemId)
    if (!m || !target) return
    const sk = storeKeyOf(target.platformId, target.token)
    const acc = this.accumulators.get(sk)
    if (!acc) return
    acc.expectedGroups = groupKeys.length
    acc.expectedFinal = true
    for (const groupKey of groupKeys) {
      this.groups.push({
        id: randomUUID(),
        jobId: this.jobId,
        merchantPoolItemId: merchantItemId,
        merchantId: target.merchantId,
        platformId: target.platformId,
        token: target.token,
        groupKey,
        status: 'queued'
      })
    }
    m.groupCount = groupKeys.length
    m.status = 'discovered'
    m.message = groupKeys.length ? `${groupKeys.length} 组` : '空店'
    m.endedAt = Date.now()
    this.markDirty()
  }

  countMerchants(status: MerchantPoolStatus | MerchantPoolStatus[]): number {
    const set = new Set(Array.isArray(status) ? status : [status])
    return this.merchants.filter((m) => set.has(m.status)).length
  }

  countGroups(status: GroupPoolStatus | GroupPoolStatus[]): number {
    const set = new Set(Array.isArray(status) ? status : [status])
    return this.groups.filter((g) => set.has(g.status)).length
  }

  openSessionCount(): number {
    return this.sessions.size
  }

  merchantsSettled(): number {
    return this.merchants.filter((m) =>
      ['discovered', 'failed', 'skipped', 'cancelled'].includes(m.status)
        ? m.status !== 'discovered' || this.storeSettled(m)
        : false
    ).length
  }

  /** Merchant is done when failed/skipped/cancelled, or discovered and store committed */
  private storeSettled(m: MerchantPoolItem): boolean {
    if (m.status !== 'discovered') return true
    const acc = this.accumulators.get(storeKeyOf(m.platformId, m.token))
    return !!acc?.committed
  }

  progressCurrent(): number {
    let n = 0
    for (const m of this.merchants) {
      if (m.status === 'failed' || m.status === 'skipped' || m.status === 'cancelled') {
        n += 1
        continue
      }
      if (m.status === 'discovered') {
        const acc = this.accumulators.get(storeKeyOf(m.platformId, m.token))
        if (acc?.committed) n += 1
      }
    }
    return n
  }

  discoverDrained(): boolean {
    return this.countMerchants(['queued', 'discovering', 'awaiting_waf']) === 0
  }

  allWorkDone(): boolean {
    if (!this.discoverDrained()) return false
    if (this.countGroups(['queued', 'running']) > 0) return false
    for (const m of this.merchants) {
      if (m.status === 'discovered') {
        const acc = this.accumulators.get(storeKeyOf(m.platformId, m.token))
        if (!acc?.committed) return false
      }
    }
    return true
  }

  cancelQueued(): void {
    const now = Date.now()
    for (const m of this.merchants) {
      if (m.status === 'queued' || m.status === 'awaiting_waf') {
        m.status = 'cancelled'
        m.endedAt = now
      }
    }
    for (const g of this.groups) {
      if (g.status === 'queued') {
        g.status = 'cancelled'
        g.endedAt = now
      }
    }
    this.markDirty()
  }
}
