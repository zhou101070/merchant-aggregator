import type { AppErrorCode } from '../types/errors'

/** Prefer actionable / specific codes when counts tie. */
const CODE_PRIORITY: AppErrorCode[] = [
  'NEED_BROWSER',
  'TIMEOUT',
  'RATE_LIMIT',
  'NETWORK',
  'DEGRADED',
  'SCHEMA_VALIDATION',
  'NOT_FOUND',
  'INVALID_URL',
  'INTERNAL'
]

const KNOWN_CODES = new Set<string>([
  'NETWORK',
  'TIMEOUT',
  'RATE_LIMIT',
  'DEGRADED',
  'SCHEMA_VALIDATION',
  'NEED_BROWSER',
  'CANCELLED',
  'NOT_FOUND',
  'INVALID_URL',
  'SYNC_LOCKED',
  'PAUSED',
  'INTERNAL'
])

function asAppErrorCode(code: string): AppErrorCode {
  return (KNOWN_CODES.has(code) ? code : 'INTERNAL') as AppErrorCode
}

/**
 * Pick a single job-level error code from per-shop failures.
 * Most frequent wins; ties break by CODE_PRIORITY.
 */
export function primaryErrorCode(errors: Array<{ code?: string | null }>): AppErrorCode | null {
  if (!errors.length) return null
  const counts = new Map<AppErrorCode, number>()
  for (const e of errors) {
    const c = asAppErrorCode(e.code?.trim() || 'INTERNAL')
    counts.set(c, (counts.get(c) ?? 0) + 1)
  }
  let best: AppErrorCode | null = null
  let bestCount = 0
  for (const [code, n] of counts) {
    if (n > bestCount) {
      best = code
      bestCount = n
      continue
    }
    if (n === bestCount && best) {
      const pi = CODE_PRIORITY.indexOf(code)
      const bi = CODE_PRIORITY.indexOf(best)
      const pNorm = pi === -1 ? 999 : pi
      const bNorm = bi === -1 ? 999 : bi
      if (pNorm < bNorm) best = code
    }
  }
  return best
}

const DETAIL_KEYS = [
  'status',
  'path',
  'platformId',
  'url',
  'reason',
  'causeCode',
  'causeMessage',
  'errno',
  'syscall',
  'address'
] as const

/** Compact one-line summary of AppError.details for UI / pool message. */
export function formatErrorDetailsSummary(details: unknown, maxLen = 220): string | null {
  if (details == null) return null
  if (typeof details === 'string') {
    const t = details.trim()
    if (!t) return null
    return t.length > maxLen ? `${t.slice(0, maxLen)}…` : t
  }
  if (typeof details !== 'object') return String(details)
  const d = details as Record<string, unknown>
  const parts: string[] = []
  for (const key of DETAIL_KEYS) {
    const v = d[key]
    if (v == null || v === '') continue
    parts.push(`${key}=${String(v)}`)
  }
  if (d.code != null && d.code !== '' && typeof d.path === 'string') {
    // shop API business code (not HTTP status)
    parts.push(`shopCode=${String(d.code)}`)
  }
  if (typeof d.snippet === 'string' && d.snippet.trim()) {
    const snip = d.snippet.replace(/\s+/g, ' ').trim().slice(0, 80)
    parts.push(`snippet=${snip}`)
  }
  if (parts.length === 0) {
    try {
      const s = JSON.stringify(details)
      if (s === '{}' || s === 'null') return null
      return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s
    } catch {
      return null
    }
  }
  const joined = parts.join(' · ')
  return joined.length > maxLen ? `${joined.slice(0, maxLen)}…` : joined
}

/** message + compact details (deduped). */
export function formatErrorWithDetails(message: string, details?: unknown): string {
  const base = message.trim() || 'error'
  const summary = formatErrorDetailsSummary(details)
  if (!summary) return base
  if (base.includes(summary)) return base
  return `${base} · ${summary}`
}
