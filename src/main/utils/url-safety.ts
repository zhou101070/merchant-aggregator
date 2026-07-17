import { AppError } from '@shared/types/errors'
import type { AppSettings } from '@shared/types/settings'

export type OpenExternalDecision =
  { action: 'allow' } | { action: 'confirm'; host: string } | { action: 'reject'; reason: string }

export function evaluateOpenExternal(
  rawUrl: string,
  settings: Pick<AppSettings, 'openExternalMode' | 'allowlistHosts'>
): OpenExternalDecision {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new AppError('INVALID_URL', 'invalid url')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('INVALID_URL', `unsupported protocol: ${url.protocol}`)
  }

  if (url.username || url.password) {
    throw new AppError('INVALID_URL', 'url must not embed credentials')
  }

  const host = url.hostname.toLowerCase()
  const allowlist = new Set(settings.allowlistHosts.map((h) => h.toLowerCase()))
  const inAllowlist = allowlist.has(host)

  if (settings.openExternalMode === 'https_only') {
    return { action: 'allow' }
  }

  if (inAllowlist) {
    return { action: 'allow' }
  }

  if (settings.openExternalMode === 'allowlist_reject') {
    return { action: 'reject', reason: `host not in allowlist: ${host}` }
  }

  return { action: 'confirm', host }
}
