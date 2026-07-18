import { AppError } from '@shared/types/errors'

export type OpenExternalDecision = { action: 'allow' } | { action: 'reject'; reason: string }

/** 仅校验协议与形态；不再做白名单。 */
export function evaluateOpenExternal(rawUrl: string): OpenExternalDecision {
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

  return { action: 'allow' }
}
