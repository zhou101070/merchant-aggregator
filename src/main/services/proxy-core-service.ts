/**
 * Embedded mihomo proxy core:
 * multi-subscription → per-group LB → root MA-LB → local mixed-port → mainFetch.
 */
import { spawn, type ChildProcess, execFile } from 'node:child_process'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  chmodSync
} from 'node:fs'
import { createGunzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { PROXY_CORE_MIHOMO_VERSION } from '@shared/constants'
import type {
  ProxyCallLogEntry,
  ProxyCoreDetail,
  ProxyCoreStatus,
  ProxyGroupInfo,
  ProxyNodeInfo
} from '@shared/types/proxy-core'
import type { ProxySubscription } from '@shared/types/proxy-subscription'
import {
  activeProxySubscriptions,
  normalizeProxySubscriptions
} from '@shared/types/proxy-subscription'
import { AppError } from '@shared/types/errors'
import { createLogger } from '../utils/logger'
import { setRuntimeProxyUrl } from '../utils/main-fetch'
import {
  buildMihomoConfig,
  mihomoAssetName,
  mihomoAssetSha256,
  mihomoBinaryName,
  mihomoDownloadUrls,
  mihomoGroupName,
  MIHOMO_LB_GROUP,
  MIHOMO_ROOT_GROUP
} from './proxy-core-config'
import {
  isVerifiedAssetMetadataCurrent,
  readVerifiedAssetRecord,
  sha256File,
  type VerifiedAssetRecord
} from './proxy-core-integrity'
import { LatestTaskQueue, type LatestTaskContext } from './latest-task-queue'
import { detectLikelyTunProxy } from './tun-detect'

const log = createLogger('proxy-core')
const CALL_LOG_MAX = 300
const CALL_LOG_POLL_MS = 1500

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** mihomo chains: [leafNode, …groups, MA-ROOT] — leaf first (Chain.Last === [0]). */
function extractOutboundNode(chains: string[]): string | null {
  if (!chains.length) return null
  for (const c of chains) {
    if (!c) continue
    if (c === MIHOMO_LB_GROUP || c === MIHOMO_ROOT_GROUP) continue
    if (c.startsWith('MA-G-')) continue
    return c
  }
  return null
}

function normalizeConnHost(host: string): string {
  return host.toLowerCase().replace(/:\d+$/, '').trim()
}

function hostMatches(want: string, got: string): boolean {
  if (!want || !got) return false
  if (want === got) return true
  return got.endsWith(`.${want}`) || want.endsWith(`.${got}`)
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      if (!addr || typeof addr === 'string') {
        s.close()
        reject(new Error('no port'))
        return
      }
      const p = addr.port
      s.close((err) => (err ? reject(err) : resolve(p)))
    })
    s.on('error', reject)
  })
}

export class ProxyCoreService {
  private child: ChildProcess | null = null
  private state: ProxyCoreStatus['state'] = 'stopped'
  private message = '未启动'
  private errorCode: string | undefined
  private mixedPort: number | null = null
  private controllerPort: number | null = null
  private secret = ''
  private enabled = false
  private subscriptions: ProxySubscription[] = []
  private callLogEnabled = false
  private callLogs: ProxyCallLogEntry[] = []
  private seenConnIds = new Set<string>()
  private pollFailWarned = false
  private pinnedNode: string | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  /** Ref-counted watch for sync HTTP node attribution (independent of call-log UI). */
  private connWatchDepth = 0
  private connWatchTimer: ReturnType<typeof setInterval> | null = null
  private connSamples: Array<{
    id: string
    host: string
    node: string
    startedAt: number
    lastSeenAt: number
  }> = []
  private nodeNamesCache: { at: number; names: string[] } | null = null
  private readonly applyQueue = new LatestTaskQueue()

  constructor(private readonly userDataPath: string) {}

  private rootDir(): string {
    return path.join(this.userDataPath, 'proxy-core')
  }

  private binDir(): string {
    return path.join(this.rootDir(), 'bin')
  }

  private binaryPath(): string {
    return path.join(this.binDir(), mihomoBinaryName(process.platform))
  }

  private configPath(): string {
    return path.join(this.rootDir(), 'config.yaml')
  }

  private secretPath(): string {
    return path.join(this.rootDir(), 'secret.txt')
  }

  private verificationPath(): string {
    return path.join(this.binDir(), 'verified-asset.json')
  }

  binaryReady(): boolean {
    if (!existsSync(this.binaryPath())) return false
    const { file } = mihomoAssetName(process.platform, process.arch, PROXY_CORE_MIHOMO_VERSION)
    return isVerifiedAssetMetadataCurrent(readVerifiedAssetRecord(this.verificationPath()), {
      version: PROXY_CORE_MIHOMO_VERSION,
      file,
      expectedArchiveSha256: mihomoAssetSha256(PROXY_CORE_MIHOMO_VERSION, file)
    })
  }

  private clearInstalledBinary(): void {
    for (const p of [this.binaryPath(), this.verificationPath()]) {
      try {
        if (existsSync(p)) unlinkSync(p)
      } catch {
        // ignore cleanup failure
      }
    }
  }

  /** Re-hash installed binary before exec; wipe and re-download on mismatch. */
  private async ensureVerifiedBinary(): Promise<void> {
    const { file } = mihomoAssetName(process.platform, process.arch, PROXY_CORE_MIHOMO_VERSION)
    const expectedArchiveSha256 = mihomoAssetSha256(PROXY_CORE_MIHOMO_VERSION, file)
    const record = readVerifiedAssetRecord(this.verificationPath())
    if (
      existsSync(this.binaryPath()) &&
      isVerifiedAssetMetadataCurrent(record, {
        version: PROXY_CORE_MIHOMO_VERSION,
        file,
        expectedArchiveSha256
      }) &&
      record
    ) {
      const actualBinarySha256 = await sha256File(this.binaryPath())
      if (actualBinarySha256 === record.binarySha256) return
      log.warn('installed mihomo binary integrity mismatch; re-download', {
        expected: record.binarySha256,
        actual: actualBinarySha256
      })
      this.clearInstalledBinary()
    }
    this.message = '下载 mihomo 内核…'
    await this.downloadBinary()
  }

  private activeSubs(): ProxySubscription[] {
    return activeProxySubscriptions(this.subscriptions)
  }

  status(): ProxyCoreStatus {
    const proxyUrl =
      this.state === 'running' && this.mixedPort
        ? `http://127.0.0.1:${this.mixedPort}`
        : null
    const tun = detectLikelyTunProxy()
    const active = this.activeSubs()
    return {
      state: this.state,
      enabled: this.enabled,
      proxyUrl,
      mixedPort: this.mixedPort,
      controllerPort: this.controllerPort,
      message: this.message,
      errorCode: this.errorCode,
      binaryReady: this.binaryReady(),
      hasSubscription: active.length > 0,
      tunLikely: tun.likely,
      tunInterfaces: tun.names,
      groupCount: this.state === 'running' ? active.length : 0,
      callLogEnabled: this.callLogEnabled,
      callLogCount: this.callLogs.length
    }
  }

  getCallLogs(): ProxyCallLogEntry[] {
    return this.callLogs.slice()
  }

  clearCallLogs(): void {
    this.callLogs = []
    this.seenConnIds.clear()
  }

  setCallLogEnabled(enabled: boolean): ProxyCoreStatus {
    this.callLogEnabled = Boolean(enabled)
    if (this.callLogEnabled && this.state === 'running') {
      this.startCallLogPoll()
    } else {
      this.stopCallLogPoll()
      if (!this.callLogEnabled) {
        this.clearCallLogs()
      }
    }
    return this.status()
  }

  /**
   * Apply settings: enable + subscriptions → ensure binary, write config, start;
   * disable → stop and clear runtime proxy.
   */
  async apply(opts: {
    enabled: boolean
    subscriptions: ProxySubscription[]
    callLogEnabled?: boolean
  }): Promise<ProxyCoreStatus> {
    this.enabled = opts.enabled
    this.subscriptions = normalizeProxySubscriptions(opts.subscriptions)
    if (opts.callLogEnabled !== undefined) {
      this.callLogEnabled = Boolean(opts.callLogEnabled)
    }

    const snapshot = {
      enabled: this.enabled,
      subscriptions: this.subscriptions.slice()
    }
    await this.applyQueue.enqueue((task) => this.applySnapshot(snapshot, task))
    return this.status()
  }

  private async applySnapshot(
    snapshot: { enabled: boolean; subscriptions: ProxySubscription[] },
    task: LatestTaskContext
  ): Promise<void> {
    if (!task.isCurrent()) return
    if (!snapshot.enabled) {
      await this.stopCore()
      if (!task.isCurrent()) return
      this.message = '已关闭'
      this.errorCode = undefined
      return
    }

    const active = activeProxySubscriptions(snapshot.subscriptions)
    if (active.length === 0) {
      await this.stopCore()
      if (!task.isCurrent()) return
      this.state = 'error'
      this.message = '请至少添加并启用一个订阅 URL'
      this.errorCode = 'NO_SUBSCRIPTION'
      return
    }

    await this.startInternal(active, task)
  }

  async getDetail(): Promise<ProxyCoreDetail> {
    const status = this.status()
    let groups: ProxyGroupInfo[] = this.activeSubs().map((s) => ({
      name: mihomoGroupName(s.id),
      subscriptionId: s.id,
      subscriptionName: s.name,
      type: 'load-balance',
      nodes: [] as ProxyNodeInfo[]
    }))

    if (this.state === 'running' && this.controllerPort) {
      try {
        const proxies = await this.controllerGet<{
          proxies?: Record<
            string,
            { type?: string; all?: string[]; history?: Array<{ delay?: number }> }
          >
        }>('/proxies')
        const map = proxies?.proxies ?? {}
        groups = groups.map((g) => {
          const info = map[g.name]
          const names = info?.all ?? []
          const nodes: ProxyNodeInfo[] = names.map((n) => {
            const p = map[n]
            const hist = p?.history
            const last = hist?.length ? hist[hist.length - 1] : undefined
            const delay =
              last && typeof last.delay === 'number' && last.delay > 0 ? last.delay : undefined
            return { name: n, delay }
          })
          return {
            ...g,
            type: info?.type ?? g.type,
            nodes
          }
        })
      } catch (e) {
        log.debug('getDetail proxies failed', { err: String(e) })
      }
    }

    return {
      status,
      groups,
      callLogs: this.getCallLogs(),
      callLogEnabled: this.callLogEnabled,
      // filled by the IPC layer (needs DB access)
      badNodes: []
    }
  }

  async stop(): Promise<void> {
    this.applyQueue.invalidate()
    await this.stopCore()
  }

  private async stopCore(): Promise<void> {
    this.stopCallLogPoll()
    setRuntimeProxyUrl(null)
    const child = this.child
    this.child = null
    if (child && !child.killed) {
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
      await sleep(200)
      try {
        if (!child.killed) child.kill('SIGKILL')
      } catch {
        // ignore
      }
    }
    this.state = 'stopped'
    this.mixedPort = null
    this.controllerPort = null
    this.pinnedNode = null
  }

  private async startInternal(
    active: ProxySubscription[],
    task: LatestTaskContext
  ): Promise<void> {
    await this.stopCore()
    if (!task.isCurrent()) return
    this.state = 'starting'
    this.message = '准备内核…'
    this.errorCode = undefined

    try {
      mkdirSync(this.binDir(), { recursive: true })
      mkdirSync(path.join(this.rootDir(), 'providers'), { recursive: true })

      await this.ensureVerifiedBinary()
      if (!task.isCurrent()) {
        await this.stopCore()
        return
      }

      this.mixedPort = await freePort()
      if (!task.isCurrent()) {
        await this.stopCore()
        return
      }
      this.controllerPort = await freePort()
      if (!task.isCurrent()) {
        await this.stopCore()
        return
      }
      this.secret = this.loadOrCreateSecret()

      const yaml = buildMihomoConfig({
        mixedPort: this.mixedPort,
        controllerPort: this.controllerPort,
        secret: this.secret,
        subscriptions: active.map((s) => ({ id: s.id, url: s.url, name: s.name }))
      })
      writeFileSync(this.configPath(), yaml, 'utf8')

      this.message = '启动内核…'
      await this.spawnCore()
      if (!task.isCurrent()) {
        await this.stopCore()
        return
      }
      await this.waitReady()
      if (!task.isCurrent()) {
        await this.stopCore()
        return
      }

      const proxyUrl = `http://127.0.0.1:${this.mixedPort}`
      setRuntimeProxyUrl(proxyUrl)
      this.state = 'running'
      this.message = `运行中 · 127.0.0.1:${this.mixedPort} · ${active.length} 组 · load-balance`
      log.info('proxy core running', {
        mixedPort: this.mixedPort,
        controllerPort: this.controllerPort,
        groups: active.length
      })
      if (this.callLogEnabled) this.startCallLogPoll()
      this.ensureConnWatchTimer()
    } catch (err) {
      await this.stopCore()
      if (!task.isCurrent()) return
      this.state = 'error'
      this.errorCode = err instanceof AppError ? err.code : 'PROXY_CORE'
      this.message = err instanceof Error ? err.message : String(err)
      log.warn('proxy core failed', { message: this.message, code: this.errorCode })
    }
  }

  private startCallLogPoll(): void {
    this.stopCallLogPoll()
    void this.pollConnections()
    this.pollTimer = setInterval(() => {
      void this.pollConnections()
    }, CALL_LOG_POLL_MS)
  }

  private stopCallLogPoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private async controllerGet<T>(apiPath: string): Promise<T> {
    const port = this.controllerPort
    if (!port) throw new Error('no controller')
    const res = await fetch(`http://127.0.0.1:${port}${apiPath}`, {
      headers: { Authorization: `Bearer ${this.secret}` }
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as T
  }

  private async controllerPut(apiPath: string, body: unknown): Promise<void> {
    const port = this.controllerPort
    if (!port) throw new Error('no controller')
    const res = await fetch(`http://127.0.0.1:${port}${apiPath}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.secret}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })
    if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`)
  }

  /**
   * Real outbound nodes selectable in MA-ROOT (groups excluded), sorted by
   * last known delay ascending; nodes without history go last.
   */
  async listNodes(): Promise<Array<{ name: string; delay?: number }>> {
    if (this.state !== 'running') return []
    const data = await this.controllerGet<{
      proxies?: Record<
        string,
        { type?: string; all?: string[]; history?: Array<{ delay?: number }> }
      >
    }>('/proxies')
    const map = data?.proxies ?? {}
    const root = map[MIHOMO_ROOT_GROUP]
    const names = (root?.all ?? []).filter((n) => n !== MIHOMO_LB_GROUP)
    const nodes = names.map((name) => {
      const hist = map[name]?.history
      const last = hist?.length ? hist[hist.length - 1] : undefined
      const delay =
        last && typeof last.delay === 'number' && last.delay > 0 ? last.delay : undefined
      return { name, delay }
    })
    const sorted = nodes.sort((a, b) => (a.delay ?? Infinity) - (b.delay ?? Infinity))
    this.nodeNamesCache = {
      at: Date.now(),
      names: sorted.map((n) => n.name.trim()).filter(Boolean)
    }
    return sorted
  }

  /** Cached node names for per-node rate limiting (refreshes every 5s). */
  async listNodeNamesCached(): Promise<string[]> {
    if (this.state !== 'running') return []
    const hit = this.nodeNamesCache
    if (hit && Date.now() - hit.at < 5_000) return hit.names
    const nodes = await this.listNodes()
    return nodes.map((n) => n.name.trim()).filter(Boolean)
  }

  /** Pin all traffic to one node (global: shared mixed-port). */
  async pinNode(name: string): Promise<void> {
    await this.controllerPut(
      `/proxies/${encodeURIComponent(MIHOMO_ROOT_GROUP)}`,
      { name }
    )
    this.pinnedNode = name
    log.info('node pinned', { name })
  }

  /** Restore load-balance routing. Safe to call when not pinned. */
  async unpinNode(): Promise<void> {
    try {
      if (this.state === 'running') {
        await this.controllerPut(
          `/proxies/${encodeURIComponent(MIHOMO_ROOT_GROUP)}`,
          { name: MIHOMO_LB_GROUP }
        )
        if (this.pinnedNode) log.info('node unpinned')
      }
    } finally {
      // Always clear local pin even if controller PUT fails (avoids sticky false pin in logs).
      this.pinnedNode = null
    }
  }

  currentPinnedNode(): string | null {
    return this.pinnedNode
  }

  /** Begin sampling mihomo connections for request→node attribution. */
  startConnWatch(): void {
    this.connWatchDepth += 1
    this.ensureConnWatchTimer()
  }

  stopConnWatch(): void {
    this.connWatchDepth = Math.max(0, this.connWatchDepth - 1)
    if (this.connWatchDepth > 0) return
    if (this.connWatchTimer) {
      clearInterval(this.connWatchTimer)
      this.connWatchTimer = null
    }
  }

  private ensureConnWatchTimer(): void {
    if (this.connWatchDepth <= 0 || this.state !== 'running' || this.connWatchTimer) return
    void this.sampleConnectionsForWatch()
    this.connWatchTimer = setInterval(() => {
      void this.sampleConnectionsForWatch()
    }, 200)
  }

  /**
   * Resolve the outbound proxy node a request likely used.
   * Prefer pin; else match sampled connections by host + time overlap.
   */
  async resolveOutboundNode(opts: {
    host: string
    startedAt: number
    endedAt?: number
  }): Promise<string | null> {
    if (this.pinnedNode) return this.pinnedNode
    if (this.state !== 'running' || !this.controllerPort) return null
    // Fresh snapshot so short-lived conns still appear
    await this.sampleConnectionsForWatch()
    return this.matchConnSample(opts.host, opts.startedAt, opts.endedAt ?? Date.now())
  }

  /** @deprecated use resolveOutboundNode */
  async peekNodeForHost(host: string): Promise<string | null> {
    return this.resolveOutboundNode({ host, startedAt: Date.now() - 5_000, endedAt: Date.now() })
  }

  private matchConnSample(host: string, startedAt: number, endedAt: number): string | null {
    const want = normalizeConnHost(host)
    if (!want || want === '—') return null
    const windowLo = startedAt - 2_000
    const windowHi = endedAt + 500
    let best: { score: number; node: string } | null = null
    for (const s of this.connSamples) {
      if (!hostMatches(want, s.host)) continue
      if (s.startedAt > windowHi || s.lastSeenAt < windowLo) continue
      // Prefer conn that started just before/at request start (actual dial for this call)
      const startDelta = Math.abs(s.startedAt - startedAt)
      const overlaps =
        s.startedAt <= endedAt && s.lastSeenAt >= startedAt - 50
      const score = (overlaps ? 0 : 1_000_000) + startDelta
      if (!best || score < best.score) best = { score, node: s.node }
    }
    return best?.node ?? null
  }

  private async sampleConnectionsForWatch(): Promise<void> {
    if (this.state !== 'running' || !this.controllerPort) return
    try {
      const data = await this.controllerGet<{
        connections?: Array<{
          id?: string
          start?: string
          chains?: string[]
          metadata?: { host?: string; destinationIP?: string }
        }>
      }>('/connections')
      const now = Date.now()
      const seen = new Set<string>()
      for (const c of data.connections ?? []) {
        const id = typeof c.id === 'string' ? c.id : ''
        if (!id) continue
        const node = extractOutboundNode(Array.isArray(c.chains) ? c.chains : [])
        if (!node) continue
        const host = normalizeConnHost(
          (c.metadata?.host && c.metadata.host.trim()) ||
            (c.metadata?.destinationIP && c.metadata.destinationIP.trim()) ||
            ''
        )
        if (!host) continue
        let startedAt = now
        if (c.start) {
          const t = Date.parse(c.start)
          if (Number.isFinite(t)) startedAt = t
        }
        seen.add(id)
        const prev = this.connSamples.find((x) => x.id === id)
        if (prev) {
          prev.lastSeenAt = now
          prev.node = node
          prev.host = host
        } else {
          this.connSamples.push({ id, host, node, startedAt, lastSeenAt: now })
        }
      }
      // Drop stale samples (closed conns not seen recently)
      this.connSamples = this.connSamples.filter(
        (s) => seen.has(s.id) || now - s.lastSeenAt < 15_000
      )
      if (this.connSamples.length > 400) {
        this.connSamples = this.connSamples
          .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
          .slice(0, 400)
      }
    } catch {
      // best-effort
    }
  }

  private async pollConnections(): Promise<void> {
    if (!this.callLogEnabled || this.state !== 'running' || !this.controllerPort) return
    try {
      const data = await this.controllerGet<{
        connections?: Array<{
          id?: string
          start?: string
          upload?: number
          download?: number
          chains?: string[]
          metadata?: {
            host?: string
            destinationIP?: string
            network?: string
          }
        }>
      }>('/connections')
      const list = data.connections ?? []
      for (const c of list) {
        const id = typeof c.id === 'string' ? c.id : ''
        if (!id || this.seenConnIds.has(id)) continue
        this.seenConnIds.add(id)
        const chains = Array.isArray(c.chains) ? c.chains : []
        // clash chains: [node, …groups, MA-LB] — node first
        const node = extractOutboundNode(chains) ?? chains[0] ?? '—'
        const group =
          chains.find((x) => typeof x === 'string' && x.startsWith('MA-G-')) ??
          chains[1] ??
          'MA-LB'
        const host =
          (c.metadata?.host && c.metadata.host.trim()) ||
          (c.metadata?.destinationIP && c.metadata.destinationIP.trim()) ||
          '—'
        let at = Date.now()
        if (c.start) {
          const t = Date.parse(c.start)
          if (Number.isFinite(t)) at = t
        }
        this.callLogs.unshift({
          id,
          at,
          group,
          node,
          host,
          network: c.metadata?.network,
          upload: typeof c.upload === 'number' ? c.upload : undefined,
          download: typeof c.download === 'number' ? c.download : undefined
        })
      }
      if (this.callLogs.length > CALL_LOG_MAX) {
        this.callLogs = this.callLogs.slice(0, CALL_LOG_MAX)
      }
      // cap seen set
      if (this.seenConnIds.size > CALL_LOG_MAX * 3) {
        const keep = new Set(this.callLogs.map((e) => e.id))
        this.seenConnIds = keep
      }
      this.pollFailWarned = false
    } catch (e) {
      // warn once per failure streak — default log level hides debug
      if (!this.pollFailWarned) {
        this.pollFailWarned = true
        log.warn('call log poll failed', { err: String(e) })
      } else {
        log.debug('poll connections failed', { err: String(e) })
      }
    }
  }

  private loadOrCreateSecret(): string {
    try {
      if (existsSync(this.secretPath())) {
        const s = readFileSync(this.secretPath(), 'utf8').trim()
        if (s.length >= 8) return s
      }
    } catch {
      // create new
    }
    const s = randomBytes(16).toString('hex')
    writeFileSync(this.secretPath(), s, 'utf8')
    return s
  }

  private async downloadBinary(): Promise<void> {
    const { file, kind } = mihomoAssetName(
      process.platform,
      process.arch,
      PROXY_CORE_MIHOMO_VERSION
    )
    const expectedSha256 = mihomoAssetSha256(PROXY_CORE_MIHOMO_VERSION, file)
    if (!expectedSha256) {
      throw new AppError('INTERNAL', `mihomo 资产缺少固定摘要: ${file}`)
    }
    const urls = mihomoDownloadUrls(PROXY_CORE_MIHOMO_VERSION, file)
    log.info('downloading mihomo', { version: PROXY_CORE_MIHOMO_VERSION, file })

    let lastStatus = 0
    let res: Response | null = null
    for (const url of urls) {
      try {
        log.info('mihomo download try', { url })
        const r = await fetch(url, { redirect: 'follow' })
        if (r.ok && r.body) {
          res = r
          break
        }
        lastStatus = r.status
        log.warn('mihomo download failed', { url, status: r.status })
      } catch (e) {
        log.warn('mihomo download error', {
          url,
          err: e instanceof Error ? e.message : String(e)
        })
      }
    }
    if (!res?.body) {
      throw new AppError(
        'NETWORK',
        `下载 mihomo 失败 HTTP ${lastStatus || 'network'}（需联网下载官方发布包并校验完整性后安装）`
      )
    }

    const tmp = path.join(this.binDir(), file)
    const out = createWriteStream(tmp)
    const reader = res.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) out.write(Buffer.from(value))
      }
      await new Promise<void>((resolve, reject) => {
        out.end(() => resolve())
        out.on('error', reject)
      })
    } catch (e) {
      out.destroy()
      throw e
    }

    const actualSha256 = await sha256File(tmp)
    if (actualSha256 !== expectedSha256) {
      try {
        unlinkSync(tmp)
      } catch {
        // ignore cleanup failure
      }
      throw new AppError('INTERNAL', 'mihomo 下载完整性校验失败', {
        file,
        expectedSha256,
        actualSha256
      })
    }

    const dest = this.binaryPath()
    if (kind === 'gz') {
      await pipeline(createReadStream(tmp), createGunzip(), createWriteStream(dest))
      try {
        chmodSync(dest, 0o755)
      } catch {
        // win n/a
      }
    } else {
      await this.unzipWindows(tmp, this.binDir())
      if (!existsSync(dest)) {
        const hit = readdirSync(this.binDir()).find(
          (n) => /^mihomo.*\.exe$/i.test(n) && n.toLowerCase() !== 'mihomo.exe'
        )
        if (hit) renameSync(path.join(this.binDir(), hit), dest)
      }
      if (!existsSync(dest)) {
        throw new AppError('INTERNAL', `解压后未找到 ${mihomoBinaryName(process.platform)}`)
      }
    }
    if (!existsSync(dest)) {
      throw new AppError('INTERNAL', `安装后未找到 ${mihomoBinaryName(process.platform)}`)
    }
    const binarySha256 = await sha256File(dest)
    const record: VerifiedAssetRecord = {
      version: PROXY_CORE_MIHOMO_VERSION,
      file,
      archiveSha256: expectedSha256,
      binarySha256
    }
    writeFileSync(this.verificationPath(), JSON.stringify(record), 'utf8')
    try {
      unlinkSync(tmp)
    } catch {
      // ignore cleanup failure
    }
  }

  private unzipWindows(zipPath: string, destDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`
        ],
        { windowsHide: true },
        (err) => (err ? reject(err) : resolve())
      )
    })
  }

  private spawnCore(): Promise<void> {
    return new Promise((resolve, reject) => {
      const bin = this.binaryPath()
      const child = spawn(bin, ['-d', this.rootDir(), '-f', this.configPath()], {
        cwd: this.rootDir(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      this.child = child
      let settled = false
      const onEarly = (code: number | null): void => {
        if (settled) return
        settled = true
        reject(new AppError('INTERNAL', `mihomo 退出 code=${code}`))
      }
      child.once('error', (err) => {
        if (settled) return
        settled = true
        reject(err)
      })
      child.once('exit', onEarly)
      setTimeout(() => {
        if (settled) return
        settled = true
        child.removeListener('exit', onEarly)
        resolve()
      }, 400)

      child.stderr?.on('data', (buf: Buffer) => {
        const line = buf.toString('utf8').trim()
        if (line) log.debug('mihomo', { line: line.slice(0, 200) })
      })
      child.on('exit', (code) => {
        if (this.child === child) {
          this.child = null
          this.stopCallLogPoll()
          setRuntimeProxyUrl(null)
          if (this.state === 'running') {
            this.state = 'error'
            this.message = `内核已退出 code=${code}`
            this.errorCode = 'EXITED'
          }
        }
      })
    })
  }

  private async waitReady(): Promise<void> {
    const port = this.controllerPort
    const secret = this.secret
    if (!port) throw new AppError('INTERNAL', 'no controller port')

    let last = ''
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/version`, {
          headers: { Authorization: `Bearer ${secret}` }
        })
        if (res.ok) return
        last = `HTTP ${res.status}`
      } catch (e) {
        last = String(e)
      }
      await sleep(250)
    }
    throw new AppError('TIMEOUT', `内核就绪超时: ${last}`)
  }
}

let singleton: ProxyCoreService | null = null

export function getProxyCoreService(): ProxyCoreService | null {
  return singleton
}

export function initProxyCoreService(userDataPath: string): ProxyCoreService {
  singleton = new ProxyCoreService(userDataPath)
  return singleton
}
