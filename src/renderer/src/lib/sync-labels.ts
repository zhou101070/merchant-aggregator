const JOB_TYPE_LABEL: Record<string, string> = {
  merchants: '同步商家',
  shop_one: '单店商品',
  shop_selected: '多选商品',
  shop_all: '全量店铺',
  ldxp_shop: '单店商品',
  ldxp_selected: '多选商品',
  ldxp_all: '全量店铺',
  bootstrap: '一键初始化',
  offers_bundle: '报价包（旧）'
}

const PHASE_LABEL: Record<string, string> = {
  starting: '启动中',
  merchants: '同步商家',
  fingerprint: '识别店铺',
  shops: '同步店铺',
  shop: '同步店铺',
  goods: '同步商品',
  ldxp_shop: '同步店铺',
  info: '读取店铺',
  done: '完成',
  error: '出错',
  cancelled: '已取消'
}

/** 错误码 → 简短用户文案 */
const ERROR_HINT: Record<string, string> = {
  NEED_BROWSER: '店铺需要人机验证，请先在浏览器打开该店后再试',
  NETWORK: '网络连接失败，请检查网络或代理后重试',
  TIMEOUT: '请求超时，请稍后重试',
  RATE_LIMIT: '请求太频繁，请调大间隔后重试',
  DEGRADED: '服务暂时不可用，请稍后重试',
  SCHEMA_VALIDATION: '店铺数据异常，站点可能已改版',
  CANCELLED: '已取消',
  SYNC_LOCKED: '已有同步任务进行中',
  PAUSED: '该平台未启用深刮',
  NOT_FOUND: '找不到对应商家或商品',
  INVALID_URL: '链接无效',
  INTERNAL: '出错了，请稍后重试'
}

const CODE_PREFIX = /^([A-Z][A-Z0-9_]+):\s*/

/** 纯英文技术句（无中文）——仅用于失败兜底，不用于成功/进行中 */
const TECH_ENGLISH = /^[a-zA-Z0-9_ .:/\-(),+;]+$/

export function jobTypeLabel(jobType?: string | null): string {
  if (!jobType) return '任务'
  return JOB_TYPE_LABEL[jobType] ?? jobType
}

export function phaseLabel(phase?: string | null): string {
  if (!phase) return ''
  return PHASE_LABEL[phase] ?? phase
}

export function errorHint(code?: string | null): string | null {
  if (!code) return null
  return ERROR_HINT[code] ?? null
}

/** IPC / catch 到的错误 → 用户可读文案 */
export function formatUserError(err: unknown): string {
  const raw = (err instanceof Error ? err.message : String(err ?? '')).trim()
  if (!raw) return ERROR_HINT.INTERNAL

  const m = raw.match(CODE_PREFIX)
  if (m) {
    const hint = ERROR_HINT[m[1]]
    if (hint) return hint
  }
  if (ERROR_HINT[raw]) return ERROR_HINT[raw]
  return ERROR_HINT.INTERNAL
}

function isFailedStatus(status?: string | null): boolean {
  return status === 'failed' || status === 'partial' || status === 'cancelled'
}

/** 任务摘要：英文 progress 转中文；技术句仅在失败时用错误码文案兜底 */
export function formatJobUserMessage(job: {
  message?: string | null
  errorCode?: string | null
  status?: string | null
}): string {
  const msg = (job.message || '').trim()
  const hint = errorHint(job.errorCode)
  const failed = isFailedStatus(job.status)

  if (msg === 'starting') return '启动中'
  if (msg === 'cancelled by user') return '已取消'

  const allOk = msg.match(/^synced (\d+) shops(?:, skipped (\d+) fresh)?$/)
  if (allOk) {
    return allOk[2] ? `已同步 ${allOk[1]} 家店，跳过 ${allOk[2]} 家` : `已同步 ${allOk[1]} 家店`
  }

  const partial = msg.match(/^synced (\d+)\/(\d+) shops, (\d+) failed(?:, skipped (\d+) fresh)?$/)
  if (partial) {
    const base = `成功 ${partial[1]}/${partial[2]} 家，失败 ${partial[3]} 家`
    return partial[4] ? `${base}，跳过 ${partial[4]} 家` : base
  }

  // 进行中：ok/fail/scraping/not-family/skip-unknown platform:token (n/m)
  const shopStep = msg.match(
    /^(ok|fail|not-family|scraping|skip-unknown)\s+\S+\s+\((\d+)\/(\d+)\)$/
  )
  if (shopStep) {
    const n = shopStep[2]
    const m = shopStep[3]
    if (shopStep[1] === 'scraping') return `正在同步第 ${n} 家，共 ${m} 家`
    if (shopStep[1] === 'ok') return `已完成 ${n}/${m} 家`
    if (shopStep[1] === 'not-family') return `第 ${n}/${m} 家类型不符，已跳过`
    if (shopStep[1] === 'skip-unknown') return `第 ${n}/${m} 家无法识别，已跳过`
    return `第 ${n}/${m} 家失败`
  }

  // 店内子进度：platform:token: cur/tot
  const inShop = msg.match(/^[^:\s]+:\S+:\s*(\d+)\/(\d+)$/)
  if (inShop) return `店内进度 ${inShop[1]}/${inShop[2]}`

  const page = msg.match(/^page (\d+)$/)
  if (page) return `正在拉取第 ${page[1]} 页`

  const probe = msg.match(/^probe yiciyuan (\S+) \((\d+)\/(\d+)\)$/)
  if (probe) return `正在识别第 ${probe[2]}/${probe[3]} 家`

  const fingerprint = msg.match(/^fingerprint matched (\d+), rejected (\d+)$/)
  if (fingerprint) {
    return `可同步 ${fingerprint[1]} 家，跳过 ${fingerprint[2]} 家`
  }

  const upserted = msg.match(
    /^upserted (\d+), dropped no-link (\d+), deleted stale (\d+), fingerprint \+(\d+)\/-(\d+)$/
  )
  if (upserted) {
    const parts = [`已更新 ${upserted[1]} 家商家`]
    if (Number(upserted[2]) > 0) parts.push(`无链接 ${upserted[2]} 家未收录`)
    if (Number(upserted[3]) > 0) parts.push(`清理过期 ${upserted[3]} 家`)
    return parts.join('，')
  }

  const bootstrapFresh = msg.match(/^merchants (\d+); top shops all fresh$/)
  if (bootstrapFresh) return `商家 ${bootstrapFresh[1]} 家已就绪；热门店无需再同步`

  if (msg === 'nothing to sync (fresh or disabled platforms)') {
    return '无需同步（均已新鲜或平台未启用）'
  }

  // 有错误码：失败摘要优先用码表（避免把英文技术句直接摊给用户）
  if (hint && (failed || job.errorCode)) return hint

  if (!msg) return hint ?? ''

  // 仅失败态才把未知英文技术句收成通用错误；成功/进行中保留或用空串避免误报
  if (TECH_ENGLISH.test(msg) && /[a-z]/.test(msg)) {
    if (failed || job.errorCode) return hint ?? ERROR_HINT.INTERNAL
    // 进行中/成功但未收录的英文：不显示吓人的「出错了」
    return ''
  }

  return msg
}

/** 按已完成比例估算剩余时间；非运行中/数据不足返回 null */
export function formatEta(job: {
  startedAt?: string | null
  current?: number | null
  total?: number | null
  status?: string | null
}): string | null {
  if (job.status && job.status !== 'running') return null
  const cur = job.current ?? 0
  const tot = job.total ?? 0
  if (!job.startedAt || cur <= 0 || tot <= cur) return null
  const elapsed = Date.now() - new Date(job.startedAt).getTime()
  if (!Number.isFinite(elapsed) || elapsed <= 0) return null
  const min = Math.round(((elapsed / cur) * (tot - cur)) / 60_000)
  return min < 1 ? '预计不到 1 分钟' : `预计还需约 ${min} 分钟`
}

/** 已用时：`32 秒` / `3 分 12 秒` / `1 小时 5 分`；无效返回 null */
export function formatElapsed(
  startedAt: string | null | undefined,
  now: number = Date.now()
): string | null {
  if (!startedAt) return null
  const t = new Date(startedAt).getTime()
  if (!Number.isFinite(t)) return null
  const sec = Math.max(0, Math.floor((now - t) / 1000))
  if (sec < 60) return `${sec} 秒`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m < 60) return s > 0 ? `${m} 分 ${s} 秒` : `${m} 分`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm > 0 ? `${h} 小时 ${rm} 分` : `${h} 小时`
}

export function formatSyncProgress(job: {
  jobType?: string | null
  phase?: string | null
  current?: number | null
  total?: number | null
  message?: string | null
  startedAt?: string | null
  status?: string | null
  errorCode?: string | null
}): string {
  const type = jobTypeLabel(job.jobType)
  const phase = phaseLabel(job.phase)
  const cur = job.current ?? 0
  const tot = job.total ?? 0
  const msg = formatJobUserMessage(job)
  const progress = tot > 0 ? `${cur}/${tot}` : cur > 0 ? `${cur}` : ''
  const eta = formatEta(job)
  return [type, phase, progress, msg, eta].filter(Boolean).join(' · ')
}

export type ShopProgressKind =
  'scraping' | 'ok' | 'fail' | 'not-family' | 'skip-unknown' | 'in_shop'

/** 从 progress.message 解析当前店与进度（供详情弹窗实时展示） */
export interface ParsedShopProgress {
  kind: ShopProgressKind
  platformId: string
  token: string
  /** 店序号 n（scraping/ok/fail 的 n/m）；店内进度时为 0 */
  index: number
  total: number
  subCurrent?: number
  subTotal?: number
}

export function parseShopProgressMessage(message?: string | null): ParsedShopProgress | null {
  const msg = (message || '').trim()
  if (!msg) return null

  const step = msg.match(
    /^(ok|fail|not-family|scraping|skip-unknown)\s+([^:\s]+):(\S+)\s+\((\d+)\/(\d+)\)$/
  )
  if (step) {
    return {
      kind: step[1] as ShopProgressKind,
      platformId: step[2],
      token: step[3],
      index: Number(step[4]),
      total: Number(step[5])
    }
  }

  const inShop = msg.match(/^([^:\s]+):(\S+):\s*(\d+)\/(\d+)$/)
  if (inShop) {
    return {
      kind: 'in_shop',
      platformId: inShop[1],
      token: inShop[2],
      index: 0,
      total: 0,
      subCurrent: Number(inShop[3]),
      subTotal: Number(inShop[4])
    }
  }

  return null
}

/** 毫秒 → 用户可读短时长：`不到 1 秒` / `3 秒` / `1 分 20 秒` */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return '不到 1 秒'
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec} 秒`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m < 60) return s > 0 ? `${m} 分 ${s} 秒` : `${m} 分`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm > 0 ? `${h} 小时 ${rm} 分` : `${h} 小时`
}
