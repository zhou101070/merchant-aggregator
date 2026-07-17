import { RECENT_SEARCHES_MAX } from '../constants'

/** Prepend query and cap list (case-insensitive dedupe, newest first). */
export function pushRecentSearch(list: string[] | null | undefined, raw: string): string[] {
  const q = raw.trim()
  if (!q) return list ? [...list] : []
  const next = [q]
  for (const item of list ?? []) {
    const t = item.trim()
    if (!t) continue
    if (t.toLocaleLowerCase('zh-CN') === q.toLocaleLowerCase('zh-CN')) continue
    next.push(t)
    if (next.length >= RECENT_SEARCHES_MAX) break
  }
  return next
}
