import { sleep } from '../services/rate-limiter'
import { beginSyncHttpRequest, endSyncHttpRequest } from '../services/sync-request-log'
import { createLogger } from './logger'

const log = createLogger('main-fetch')

/** Extra attempts after first failure for transient TLS/socket drops. */
const TRANSIENT_FETCH_RETRIES = 2
const TRANSIENT_BACKOFF_MS = [200, 500] as const

type ElectronSession = {
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
  resolveProxy?: (url: string) => Promise<string>
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
 * - otherwise → direct (do not follow OS proxy either)
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
        await ses.setProxy({ mode: 'direct' })
        log.info('app session proxy mode=direct (not OS)')
      }
    } catch (err) {
      log.warn('ensureSystemProxy failed', { err: String(err) })
    }
  })()
  return proxyInit
}

async function electronFetchers(): Promise<{
  fetch: ((input: string, init?: RequestInit) => Promise<Response>) | null
  resolveProxy: ((url: string) => Promise<string>) | null
  setProxy: ElectronSession['setProxy'] | null
  via: string
}> {
  try {
    const electron = await import('electron')
    const ses = electron.session?.defaultSession as unknown as ElectronSession | undefined
    if (ses && typeof ses.fetch === 'function') {
      return {
        fetch: (input, init) => ses.fetch!(input, init),
        resolveProxy: ses.resolveProxy ? (u) => ses.resolveProxy!(u) : null,
        setProxy: ses.setProxy ? (cfg) => ses.setProxy!(cfg) : null,
        via: 'session.fetch'
      }
    }
    const net = electron.net as unknown as ElectronNet | undefined
    if (net && typeof net.fetch === 'function') {
      return {
        fetch: (input, init) => net.fetch(input, init),
        resolveProxy: ses?.resolveProxy ? (u) => ses.resolveProxy!(u) : null,
        setProxy: ses?.setProxy ? (cfg) => ses.setProxy!(cfg) : null,
        via: 'net.fetch'
      }
    }
  } catch {
    // vitest / plain node
  }
  return { fetch: null, resolveProxy: null, setProxy: null, via: 'node-fetch' }
}

/** "PROXY 127.0.0.1:7890; DIRECT" → "127.0.0.1:7890" */
function proxyRulesFromResolve(rule: string | undefined | null): string | null {
  if (!rule) return null
  const m = rule.match(/PROXY\s+([^\s;]+)/i)
  return m ? m[1].replace(/\/$/, '') : null
}

async function fetchViaUndiciProxy(
  url: string,
  init: RequestInit | undefined,
  proxyHostPort: string
): Promise<Response> {
  const proxyUrl = proxyHostPort.includes('://') ? proxyHostPort : `http://${proxyHostPort}`
  const undici = await import('undici')
  const agent = new undici.ProxyAgent(proxyUrl)
  log.info('fetch via undici ProxyAgent', { proxyUrl })
  return (await undici.fetch(url, {
    ...(init as object),
    dispatcher: agent
  })) as unknown as Response
}

function abortError(): Error {
  const err = new Error('The operation was aborted')
  err.name = 'AbortError'
  return err
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
  const electronInit: RequestInit = { ...rest }
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

async function withTransientRetries<T>(
  label: string,
  fn: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  let last: unknown
  for (let attempt = 0; attempt <= TRANSIENT_FETCH_RETRIES; attempt++) {
    if (signal?.aborted) throw abortError()
    try {
      return await fn()
    } catch (err) {
      last = err
      if (err instanceof Error && err.name === 'AbortError') throw err
      if (!isTransientNetworkError(err) || attempt >= TRANSIENT_FETCH_RETRIES) throw err
      const delay = TRANSIENT_BACKOFF_MS[attempt] ?? 500
      log.info('transient fetch retry', {
        label,
        attempt: attempt + 1,
        delay,
        err: String(err)
      })
      try {
        await sleep(delay, signal)
      } catch (sleepErr) {
        if (sleepErr instanceof Error && sleepErr.name === 'AbortError') throw abortError()
        throw sleepErr
      }
    }
  }
  throw last
}

/**
 * Main-process HTTP via Chromium network (system/fixed proxy).
 * Does not fall back to bare Node fetch after a Chromium failure (that hits fake-ip).
 */
export async function mainFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  await ensureSystemProxy()
  const url = String(input)
  const method = (init?.method || 'GET').toUpperCase()
  const logId = beginSyncHttpRequest({ method, url })
  try {
    const res = await mainFetchInner(url, init)
    endSyncHttpRequest(logId, { status: res.status })
    return res
  } catch (err) {
    endSyncHttpRequest(logId, {
      status: null,
      error: err instanceof Error ? err.message : String(err)
    })
    throw err
  }
}

async function mainFetchInner(url: string, init?: RequestInit): Promise<Response> {
  const { fetch: eFetch, resolveProxy, setProxy, via } = await electronFetchers()

  if (!eFetch) {
    const fixed = envProxyRules()
    if (fixed) {
      try {
        return await withTransientRetries(
          'undici-proxy',
          () => fetchViaUndiciProxy(url, init, fixed),
          init?.signal ?? undefined
        )
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err
        throw wrapFetchError(err, { via: 'undici-proxy', url, proxy: fixed })
      }
    }
    return withTransientRetries('node-fetch', () => fetch(url, init), init?.signal ?? undefined)
  }

  const { electronInit, signal } = splitElectronInit(init)

  try {
    return await withTransientRetries(
      via,
      () => withAbortSignal(eFetch(url, electronInit), signal),
      signal
    )
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err

    let resolved: string | undefined
    try {
      resolved = resolveProxy ? await resolveProxy(url) : undefined
    } catch {
      resolved = undefined
    }
    const fromResolve = proxyRulesFromResolve(resolved)
    const fromEnv = envProxyRules()
    const proxyHost = fromResolve || fromEnv

    // Recovery 1: pin Chromium to explicit proxy host
    if (proxyHost && setProxy) {
      try {
        await setProxy({ mode: 'fixed_servers', proxyRules: proxyHost })
        log.info('retry chromium with fixed_servers', { proxyHost, resolved })
        const res = await withTransientRetries(
          'chromium-fixed',
          () => withAbortSignal(eFetch(url, electronInit), signal),
          signal
        )
        try {
          await setProxy({
            mode: fromEnv ? 'fixed_servers' : 'direct',
            proxyRules: fromEnv || undefined
          })
        } catch {
          // ignore restore failure
        }
        return res
      } catch (err2) {
        if (err2 instanceof Error && err2.name === 'AbortError') throw err2
        log.warn('fixed_servers retry failed', fetchErrorDetails(err2))
      }
    }

    // Recovery 2: undici ProxyAgent (works when Chromium proxy mis-applies)
    if (proxyHost) {
      try {
        return await withTransientRetries(
          'undici-proxy',
          () => withAbortSignal(fetchViaUndiciProxy(url, init, proxyHost), signal),
          signal
        )
      } catch (err3) {
        if (err3 instanceof Error && err3.name === 'AbortError') throw err3
        log.warn('undici proxy retry failed', fetchErrorDetails(err3))
        throw wrapFetchError(err3, {
          via: 'undici-proxy',
          url,
          proxy: proxyHost,
          resolved,
          firstError: String(err)
        })
      }
    }

    throw wrapFetchError(err, { via, url, proxy: resolved })
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

/** Serialize fetch/undici failure cause for job meta / logs. */
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
