import { AppError } from '@shared/types/errors'
import { DUJIAO_PLATFORM_ID, YICIYUAN_PLATFORM_ID } from '@shared/platforms/identify'
import { createLogger } from '../../utils/logger'
import { fetchErrorDetails, mainFetch } from '../../utils/main-fetch'
import { browserJsonGetHeaders, resolveRequestUserAgent } from '../../utils/request-headers'
import { resolveDujiaoBaseUrl } from '../dujiao/client'
import { resolveYiciyuanBaseUrl } from '../yiciyuan/client'

const log = createLogger('fingerprint')

export type FingerprintKind = 'match' | 'not_family' | 'network'

export interface FingerprintResult {
  kind: FingerprintKind
  platformId: string
  baseUrl: string
  message: string
  details?: Record<string, unknown>
}

async function fetchText(
  url: string,
  origin: string
): Promise<{ ok: boolean; status: number; text: string }> {
  const headers = browserJsonGetHeaders({
    userAgent: resolveRequestUserAgent(),
    origin,
    referer: `${origin}/`,
    fetchSite: 'same-origin'
  })
  let res: Response
  try {
    res = await mainFetch(url, { method: 'GET', headers })
  } catch (err) {
    throw new AppError('NETWORK', `fingerprint fetch failed: ${String(err)}`, {
      url,
      ...fetchErrorDetails(err)
    })
  }
  const text = await res.text()
  return { ok: res.ok, status: res.status, text }
}

/** Probe 异次元 public catalog API shape. */
export async function probeYiciyuan(opts: {
  host?: string | null
  shopUrl?: string | null
  entryUrl?: string | null
  baseUrl?: string | null
}): Promise<FingerprintResult> {
  const baseUrl = resolveYiciyuanBaseUrl(opts)
  const url = `${baseUrl}/user/api/index/data`
  try {
    const { ok, status, text } = await fetchText(url, baseUrl)
    if (!ok) {
      return {
        kind: 'network',
        platformId: YICIYUAN_PLATFORM_ID,
        baseUrl,
        message: `HTTP ${status}`,
        details: { status, snippet: text.slice(0, 160) }
      }
    }
    const trimmed = text.trim()
    if (!trimmed.startsWith('{')) {
      return {
        kind: 'not_family',
        platformId: YICIYUAN_PLATFORM_ID,
        baseUrl,
        message: '响应非 JSON，不是异次元公开 API',
        details: { snippet: trimmed.slice(0, 160) }
      }
    }
    let json: { code?: number; data?: unknown }
    try {
      json = JSON.parse(trimmed) as { code?: number; data?: unknown }
    } catch {
      return {
        kind: 'not_family',
        platformId: YICIYUAN_PLATFORM_ID,
        baseUrl,
        message: 'JSON 解析失败',
        details: { snippet: trimmed.slice(0, 160) }
      }
    }
    if (json.code !== 200 || !Array.isArray(json.data)) {
      return {
        kind: 'not_family',
        platformId: YICIYUAN_PLATFORM_ID,
        baseUrl,
        message: `信封不符 code=${json.code} dataArray=${Array.isArray(json.data)}`,
        details: { code: json.code }
      }
    }
    log.info('yiciyuan probe match', { baseUrl, categories: json.data.length })
    return {
      kind: 'match',
      platformId: YICIYUAN_PLATFORM_ID,
      baseUrl,
      message: `ok categories=${json.data.length}`
    }
  } catch (err) {
    if (err instanceof AppError && err.code === 'NETWORK') {
      return {
        kind: 'network',
        platformId: YICIYUAN_PLATFORM_ID,
        baseUrl,
        message: err.message,
        details: err.details as Record<string, unknown> | undefined
      }
    }
    throw err
  }
}

/** Probe 独角 Next public config. */
export async function probeDujiao(opts: {
  host?: string | null
  shopUrl?: string | null
  entryUrl?: string | null
  baseUrl?: string | null
}): Promise<FingerprintResult> {
  const baseUrl = resolveDujiaoBaseUrl(opts)
  const url = `${baseUrl}/api/v1/public/config`
  try {
    const { ok, status, text } = await fetchText(url, baseUrl)
    if (!ok) {
      return {
        kind: 'network',
        platformId: DUJIAO_PLATFORM_ID,
        baseUrl,
        message: `HTTP ${status}`,
        details: { status, snippet: text.slice(0, 160) }
      }
    }
    const trimmed = text.trim()
    if (!trimmed.startsWith('{')) {
      return {
        kind: 'not_family',
        platformId: DUJIAO_PLATFORM_ID,
        baseUrl,
        message: '响应非 JSON，不是独角 Next 公开 API',
        details: { snippet: trimmed.slice(0, 160) }
      }
    }
    let json: { status_code?: number; data?: unknown }
    try {
      json = JSON.parse(trimmed) as { status_code?: number; data?: unknown }
    } catch {
      return {
        kind: 'not_family',
        platformId: DUJIAO_PLATFORM_ID,
        baseUrl,
        message: 'JSON 解析失败',
        details: { snippet: trimmed.slice(0, 160) }
      }
    }
    if (json.status_code !== 0 || json.data == null || typeof json.data !== 'object') {
      return {
        kind: 'not_family',
        platformId: DUJIAO_PLATFORM_ID,
        baseUrl,
        message: `信封不符 status_code=${json.status_code}`,
        details: { status_code: json.status_code }
      }
    }
    log.info('dujiao probe match', { baseUrl })
    return {
      kind: 'match',
      platformId: DUJIAO_PLATFORM_ID,
      baseUrl,
      message: 'ok'
    }
  } catch (err) {
    if (err instanceof AppError && err.code === 'NETWORK') {
      return {
        kind: 'network',
        platformId: DUJIAO_PLATFORM_ID,
        baseUrl,
        message: err.message,
        details: err.details as Record<string, unknown> | undefined
      }
    }
    throw err
  }
}

export async function probeHostTokenPlatform(
  platformId: string,
  opts: {
    host?: string | null
    shopUrl?: string | null
    entryUrl?: string | null
    baseUrl?: string | null
  }
): Promise<FingerprintResult | null> {
  if (platformId === YICIYUAN_PLATFORM_ID || platformId === 'kami') {
    return probeYiciyuan(opts)
  }
  if (platformId === DUJIAO_PLATFORM_ID) {
    return probeDujiao(opts)
  }
  return null
}
