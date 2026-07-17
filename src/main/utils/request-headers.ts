/**
 * Unified browser-like request headers for all outbound HTTP (PriceAI + shopApi).
 * Aligns UA / Client Hints / Sec-Fetch with desktop Chrome — not full fingerprint spoofing.
 */

import { LEGACY_IDENTIFIABLE_PRICEAI_UA } from '@shared/constants'

const FALLBACK_CHROME = '131.0.0.0'
export const BROWSER_ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.8'

export type BrowserPlatform = 'Windows' | 'macOS' | 'Linux'

export function resolveChromeVersion(): string {
  const fromElectron =
    typeof process !== 'undefined' && process.versions && typeof process.versions.chrome === 'string'
      ? process.versions.chrome
      : null
  if (fromElectron && /^\d+(\.\d+){1,3}$/.test(fromElectron)) return fromElectron
  return FALLBACK_CHROME
}

export function resolveBrowserPlatform(
  nodePlatform: NodeJS.Platform = process.platform
): BrowserPlatform {
  if (nodePlatform === 'win32') return 'Windows'
  if (nodePlatform === 'darwin') return 'macOS'
  return 'Linux'
}

export function chromeMajor(version: string): string {
  const m = version.match(/^(\d+)/)
  return m ? m[1] : '131'
}

/** Desktop Chrome UA matching host OS + Chromium version. */
export function resolveChromeUserAgent(
  options?: { chromeVersion?: string; platform?: BrowserPlatform }
): string {
  const version = options?.chromeVersion ?? resolveChromeVersion()
  const platform = options?.platform ?? resolveBrowserPlatform()
  const osToken =
    platform === 'Windows'
      ? 'Windows NT 10.0; Win64; x64'
      : platform === 'macOS'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`
}

/**
 * Resolve effective UA: empty / legacy identifiable → desktop Chrome.
 * Explicit non-legacy override (settings.priceaiUa) is kept as-is.
 */
export function resolveRequestUserAgent(override?: string | null): string {
  const trimmed = override?.trim()
  if (!trimmed || trimmed === LEGACY_IDENTIFIABLE_PRICEAI_UA) {
    return resolveChromeUserAgent()
  }
  return trimmed
}

function clientHintHeaders(ua: string, platform: BrowserPlatform): Record<string, string> {
  const major = chromeMajor(ua.match(/Chrome\/([\d.]+)/)?.[1] ?? FALLBACK_CHROME)
  return {
    'sec-ch-ua': `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not_A Brand";v="24"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': `"${platform}"`
  }
}

export interface BaseBrowserHeaderOptions {
  userAgent: string
  platform?: BrowserPlatform
}

/** Shared core: UA + language + Client Hints. */
export function browserBaseHeaders(options: BaseBrowserHeaderOptions): Record<string, string> {
  const platform = options.platform ?? resolveBrowserPlatform()
  return {
    'User-Agent': options.userAgent,
    'Accept-Language': BROWSER_ACCEPT_LANGUAGE,
    ...clientHintHeaders(options.userAgent, platform)
  }
}

export interface JsonGetHeadersOptions extends BaseBrowserHeaderOptions {
  /** Sec-Fetch-Site; default none (no page context, main-process fetch). */
  fetchSite?: 'none' | 'same-origin' | 'same-site' | 'cross-site'
  referer?: string
  origin?: string
}

/** JSON GET (PriceAI / generic HttpClient). */
export function browserJsonGetHeaders(options: JsonGetHeadersOptions): Record<string, string> {
  const headers: Record<string, string> = {
    ...browserBaseHeaders(options),
    Accept: 'application/json, text/plain, */*',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': options.fetchSite ?? 'none'
  }
  if (options.referer) headers.Referer = options.referer
  if (options.origin) headers.Origin = options.origin
  return headers
}

export interface DocumentNavHeadersOptions extends BaseBrowserHeaderOptions {
  visitorId?: string
}

/** First-party document navigation (shop page warmup). */
export function browserDocumentHeaders(options: DocumentNavHeadersOptions): Record<string, string> {
  const headers: Record<string, string> = {
    ...browserBaseHeaders(options),
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1'
  }
  if (options.visitorId) headers.Visitorid = options.visitorId
  return headers
}

export interface CorsApiHeadersOptions extends BaseBrowserHeaderOptions {
  origin: string
  referer: string
  visitorId?: string
  cookie?: string
  contentType?: string
}

/** Same-origin XHR/fetch JSON API (shopApi POST). */
export function browserCorsApiHeaders(options: CorsApiHeadersOptions): Record<string, string> {
  const headers: Record<string, string> = {
    ...browserBaseHeaders(options),
    'Content-Type': options.contentType ?? 'application/json',
    Accept: 'application/json, text/plain, */*',
    Origin: options.origin,
    Referer: options.referer,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin'
  }
  if (options.visitorId) headers.Visitorid = options.visitorId
  if (options.cookie) headers.Cookie = options.cookie
  return headers
}
