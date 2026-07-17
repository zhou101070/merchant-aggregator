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
  starting: '启动',
  merchants: '拉商家',
  shops: '刮店铺',
  shop: '刮店铺',
  goods: '拉商品',
  ldxp_shop: '刮店铺',
  info: '读店铺信息',
  done: '完成',
  error: '错误',
  cancelled: '取消'
}

/** 错误码 → 用户可执行的提示；未知码原样返回 */
const ERROR_HINT: Record<string, string> = {
  NEED_BROWSER: '店铺触发了人机验证：先在浏览器打开一次该店铺，稍后重试',
  NETWORK: '网络错误，部分请求失败，可稍后重试',
  TIMEOUT: '请求超时，稍后重试',
  RATE_LIMIT: '触发限流，建议调大请求间隔后重试',
  DEGRADED: '上游服务降级，稍后重试',
  SCHEMA_VALIDATION: '上游返回了意外格式，站点可能已改版',
  CANCELLED: '已取消',
  SYNC_LOCKED: '已有同类同步在进行中，等它结束或先取消',
  PAUSED: '同步已暂停（设置关闭，或该平台尚未启用）',
  NOT_FOUND: '找不到目标：商家不存在或缺少可刮店铺信息',
  INVALID_URL: '链接不合法或未注册的店铺域名',
  INTERNAL: '内部错误，请查看日志'
}

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
  return ERROR_HINT[code] ?? code
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

export function formatSyncProgress(job: {
  jobType?: string | null
  phase?: string | null
  current?: number | null
  total?: number | null
  message?: string | null
  startedAt?: string | null
  status?: string | null
}): string {
  const type = jobTypeLabel(job.jobType)
  const phase = phaseLabel(job.phase)
  const cur = job.current ?? 0
  const tot = job.total ?? 0
  const msg = (job.message || '').trim()
  const progress = tot > 0 ? `${cur}/${tot}` : cur > 0 ? `${cur}` : ''
  const eta = formatEta(job)
  return [type, phase, progress, msg, eta].filter(Boolean).join(' · ')
}
