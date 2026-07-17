/** 相对时间：'刚刚 / N 分钟前 / N 小时前 / N 天前'；无值返回 '—' */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return '—'
  const diff = Date.now() - t
  if (diff < 60_000) return '刚刚'
  const min = Math.floor(diff / 60_000)
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return new Date(t).toLocaleDateString()
}

/** 数据是否超过新鲜期(缺时间戳视为过期) */
export function isStale(iso: string | null | undefined, freshHours: number): boolean {
  if (!iso) return true
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return true
  return Date.now() - t > freshHours * 3_600_000
}
