import { RATE_LIMITS } from '@shared/constants'
import { AppError } from '@shared/types/errors'
import { beginSyncHttpRequest, endSyncHttpRequest } from '../services/sync-request-log'
import { abortError, isAbortError } from './abort'
import { createLogger } from './logger'

const log = createLogger('main-fetch')

type ElectronSession = {
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
  setProxy?: (config: {
    mode: string
    proxyRules?: string
    proxyBypassRules?: string
  }) => Promise<void>
}

type ElectronNet = {
  fetch: (input: string, init?: RequestInit) => Promise<Response>
}

let proxyInit: Promise<void> | null = null

function envProxyRules(): string | null {
  const raw =
    process.env['MA_PROXY'] ||
    process.env['HTTPS_PROXY'] ||
    process.env['https_proxy'] ||
    process.env['HTTP_PROXY'] ||
    process.env['http_proxy'] ||
    process.env['ALL_PROXY'] ||
    process.env['all_proxy']
  if (!raw?.trim()) return null
  // Chromium proxyRules wants host:port without scheme for http proxies
  try {
    const u = new URL(raw.includes('://') ? raw : `http://${raw}`)
    return `${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`
  } catch {
    return raw.replace(/^https?:\/\//i, '').replace(/\/$/, '')
  }
}

/**
 * Apply proxy ONLY to this app's Electron session.defaultSession.
 * Never writes OS / system proxy settings; other apps are unaffected.
 * - MA_PROXY / HTTP(S)_PROXY → fixed_servers
 * - otherwise → system (follow OS proxy, same path as browser)
 */
export async function ensureSystemProxy(): Promise<void> {
  if (proxyInit) return proxyInit
  proxyInit = (async () => {
    try {
      const { session } = await import('electron')
      const ses = session.defaultSession as unknown as ElectronSession
      if (typeof ses.setProxy !== 'function') return
      const fixed = envProxyRules()
      if (fixed) {
        await ses.setProxy({ mode: 'fixed_servers', proxyRules: fixed })
        log.info('app session proxy fixed_servers (not OS)', { proxyRules: fixed })
      } else {
        await ses.setProxy({ mode: 'system' })
        log.info('app session proxy mode=system (follow OS; not writing OS)')
      }
    } catch (err) {
      log.warn('ensureSystemProxy failed', { err: String(err) })
    }
  })()
  return proxyInit
}

async function electronFetchers(): Promise<{
  fetch: ((input: string, init?: RequestInit) => Promise<Response>) | null
  via: string
}> {
  try {
    const electron = await import('electron')
    const ses = electron.session?.defaultSession as unknown as ElectronSession | undefined
    if (ses && typeof ses.fetch === 'function') {
      return {
        fetch: (input, init) => ses.fetch!(input, init),
        via: 'session.fetch'
      }
    }
    const net = electron.net as unknown as ElectronNet | undefined
    if (net && typeof net.fetch === 'function') {
      return {
        fetch: (input, init) => net.fetch(input, init),
        via: 'net.fetch'
      }
    }
  } catch {
    // vitest / plain node
  }
  return { fetch: null, via: 'node-fetch' }
}

/** Chromium session.fetch rejects these Sec-Fetch-Mode values with ERR_INVALID_ARGUMENT. */
const ELECTRON_BAD_SEC_FETCH_MODES = new Set(['cors', 'same-origin'])

/**
 * Prepare RequestInit for Electron session/net.fetch:
 * - Drop Node AbortSignal (honor via Promise race instead)
 * - Drop Sec-Fetch-Mode cors|same-origin (ERR_INVALID_ARGUMENT)
 */
function splitElectronInit(init?: RequestInit): {
  electronInit?: RequestInit
  signal?: AbortSignal
} {
  if (!init) return {}
  const { signal, headers, ...rest } = init
  const electronInit: RequestInit = {
    ...rest,
    // Keep challenge/session cookies in the same Chromium session. Direct API
    // callers do not have a renderer origin, so Electron's default can omit them.
    credentials: rest.credentials ?? 'include'
  }
  if (headers != null) {
    electronInit.headers = sanitizeElectronHeaders(headers)
  }
  return { electronInit, signal: signal ?? undefined }
}

function sanitizeElectronHeaders(headers: HeadersInit): HeadersInit {
  if (headers instanceof Headers) {
    const out = new Headers(headers)
    const mode = out.get('Sec-Fetch-Mode')
    if (mode && ELECTRON_BAD_SEC_FETCH_MODES.has(mode.toLowerCase())) {
      out.delete('Sec-Fetch-Mode')
    }
    return out
  }
  if (Array.isArray(headers)) {
    return headers.filter(
      ([k, v]) =>
        k.toLowerCase() !== 'sec-fetch-mode' ||
        !ELECTRON_BAD_SEC_FETCH_MODES.has(String(v).toLowerCase())
    )
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (
      k.toLowerCase() === 'sec-fetch-mode' &&
      ELECTRON_BAD_SEC_FETCH_MODES.has(String(v).toLowerCase())
    ) {
      continue
    }
    out[k] = String(v)
  }
  return out
}

function withAbortSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      }
    )
  })
}

/** Combine caller cancel + per-request timeout (AbortSignal.any when available). */
export function mergeAbortSignals(
  ...signals: Array<AbortSignal | null | undefined>
): AbortSignal | undefined {
  const list = signals.filter((s): s is AbortSignal => s != null)
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(list)
  }
  const controller = new AbortController()
  const onAbort = (): void => {
    controller.abort()
  }
  for (const s of list) {
    if (s.aborted) {
      controller.abort()
      return controller.signal
    }
    s.addEventListener('abort', onAbort, { once: true })
  }
  return controller.signal
}

function withDefaultTimeout(
  init: RequestInit | undefined,
  timeoutMs: number
): { init: RequestInit; clear: () => void } {
  const timeoutController = new AbortController()
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs)
  const signal = mergeAbortSignals(init?.signal, timeoutController.signal)
  return {
    init: { ...init, signal },
    clear: () => clearTimeout(timer)
  }
}

/**
 * True for short-lived socket/TLS drops worth a quick retry
 * (e.g. Chromium net_error -100 CONNECTION_CLOSED during SSL handshake).
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return false
  const details = fetchErrorDetails(err)
  const blob = [
    String(err),
    String(details.error ?? ''),
    String(details.causeCode ?? ''),
    String(details.causeMessage ?? ''),
    String(details.errno ?? '')
  ]
    .join(' ')
    .toLowerCase()
  return /err_connection_closed|err_connection_reset|err_connection_refused|err_connection_timed_out|err_connection_aborted|err_ssl|err_network_changed|err_empty_response|err_timed_out|err_internet_disconnected|err_address_unreachable|handshake failed|net_error\s*-100|net_error\s*-101|net_error\s*-102|net_error\s*-106|net_error\s*-107|net_error\s*-118|net_error\s*-21|econnreset|econnrefused|etimedout|eai_again|socket hang up|ssl_error|tls/i.test(
    blob
  )
}

/**
 * Main-process HTTP via Chromium network (system/fixed proxy).
 * Always applies a default request timeout so sync UI never stays on「连接中」forever.
 * Does not fall back to bare Node fetch after a Chromium failure (that hits fake-ip).
 */
export async function mainFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  await ensureSystemProxy()
  const url = String(input)
  const method = (init?.method || 'GET').toUpperCase()
  const logId = beginSyncHttpRequest({ method, url })
  const timed = withDefaultTimeout(init, RATE_LIMITS.requestTimeoutMs)
  try {
    const res = await mainFetchInner(url, timed.init)
    endSyncHttpRequest(logId, { status: res.status })
    return res
  } catch (err) {
    endSyncHttpRequest(logId, {
      status: null,
      error: err instanceof Error ? err.message : String(err)
    })
    // withDefaultTimeout merges caller signal + request timeout.
    // Only caller abort is cancel; bare AbortError here is request timeout.
    if (isAbortError(err)) {
      if (init?.signal?.aborted) throw abortError()
      throw new AppError('TIMEOUT', `request timeout: ${url}`, { url })
    }
    throw err
  } finally {
    timed.clear()
  }
}

async function mainFetchInner(url: string, init?: RequestInit): Promise<Response> {
  const { fetch: eFetch, via } = await electronFetchers()

  if (!eFetch) {
    return fetch(url, init)
  }

  const { electronInit, signal } = splitElectronInit(init)

  try {
    return await withAbortSignal(eFetch(url, electronInit), signal)
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err
    throw wrapFetchError(err, { via, url })
  }
}

function wrapFetchError(
  err: unknown,
  extra: Record<string, unknown>
): Error & { cause?: unknown; details?: Record<string, unknown> } {
  const wrapped = new Error(`fetch failed via ${extra.via ?? '?'}: ${String(err)}`) as Error & {
    cause?: unknown
    details?: Record<string, unknown>
  }
  wrapped.cause = err
  wrapped.details = { ...extra, ...fetchErrorDetails(err) }
  return wrapped
}

/** Serialize transport failure causes for job meta / logs. */
export function fetchErrorDetails(err: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { error: String(err) }
  if (!err || typeof err !== 'object') return out
  const any = err as { cause?: unknown; details?: Record<string, unknown> }
  if (any.details && typeof any.details === 'object') {
    Object.assign(out, any.details)
  }
  const walk = (cause: unknown, depth: number): void => {
    if (!cause || typeof cause !== 'object' || depth > 3) return
    const c = cause as Record<string, unknown>
    if (c.code != null && out.causeCode == null) out.causeCode = c.code
    if (c.message != null && out.causeMessage == null) out.causeMessage = String(c.message)
    if (c.errno != null && out.errno == null) out.errno = c.errno
    if (c.syscall != null && out.syscall == null) out.syscall = c.syscall
    if (c.address != null && out.address == null) out.address = c.address
    if (c.port != null && out.port == null) out.port = c.port
    if ('cause' in c) walk(c.cause, depth + 1)
  }
  walk(any.cause, 0)
  if (any.cause != null && out.cause == null && typeof any.cause !== 'object') {
    out.cause = String(any.cause)
  }
  return out
}
