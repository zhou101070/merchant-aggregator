/**
 * Interactive WAF / captcha window: dedicated session + optional env proxy.
 * Auto-detects pass when the page navigates/refreshes to a non-challenge storefront.
 */
import { BrowserWindow, session } from 'electron'
import {
  isShopApiChallengeResponse,
  isShopStorefrontHtml
} from '../platforms/shopapi/challenge'
import { createLogger } from '../utils/logger'

const log = createLogger('waf-window')

const WAF_TIMEOUT_MS = 5 * 60_000
const CHECK_DEBOUNCE_MS = 400
/** Chromium net::ERR_ABORTED — common on redirects / superseding navigations. */
const ERR_ABORTED = -3
let openCount = 0
const MAX_OPEN = 1

export type WafChallengeCookie = { name: string; value: string }

export type WafChallengeResult =
  | { ok: true; cookies: WafChallengeCookie[]; node: string | null }
  | { ok: false; reason: string }

type ProxyAttempt = {
  label: string
  mode: 'fixed_servers' | 'direct'
  rules?: string
}

function proxyRulesFromUrl(proxyUrl: string): string {
  try {
    const u = new URL(proxyUrl.includes('://') ? proxyUrl : `http://${proxyUrl}`)
    return `${u.hostname}:${u.port || '80'}`
  } catch {
    return proxyUrl.replace(/^https?:\/\//i, '').replace(/\/$/, '')
  }
}

function envProxyUrl(): string | null {
  const raw =
    process.env['MA_PROXY'] ||
    process.env['HTTPS_PROXY'] ||
    process.env['https_proxy'] ||
    process.env['HTTP_PROXY'] ||
    process.env['http_proxy'] ||
    process.env['ALL_PROXY'] ||
    process.env['all_proxy']
  return raw?.trim() || null
}

function buildProxyAttempts(): ProxyAttempt[] {
  const attempts: ProxyAttempt[] = []
  const seen = new Set<string>()
  const push = (a: ProxyAttempt): void => {
    const key = a.mode === 'direct' ? 'direct' : `fixed:${a.rules ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    attempts.push(a)
  }
  const env = envProxyUrl()
  if (env) {
    push({
      label: 'env-proxy',
      mode: 'fixed_servers',
      rules: proxyRulesFromUrl(env)
    })
  }
  push({ label: 'direct', mode: 'direct' })
  return attempts
}

async function applyProxyAttempt(
  ses: Electron.Session,
  attempt: ProxyAttempt
): Promise<void> {
  if (attempt.mode === 'direct' || !attempt.rules) {
    await ses.setProxy({ mode: 'direct' })
    return
  }
  await ses.setProxy({ mode: 'fixed_servers', proxyRules: attempt.rules })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function loadErrorDataUrl(opts: {
  errorCode: number
  errorDescription: string
  url: string
  proxyLabel: string
  shopUrl: string
}): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>加载失败</title>
<style>
  body{font-family:system-ui,sans-serif;padding:40px;max-width:640px;margin:0 auto;color:#1a1a1a;line-height:1.5}
  h1{font-size:1.25rem;margin:0 0 12px}
  p{margin:8px 0;color:#333}
  code{background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:12px;word-break:break-all}
  .muted{color:#6b7280;font-size:13px}
</style></head><body>
  <h1>店铺页加载失败</h1>
  <p class="muted">人机验证窗口无法打开目标页。可关闭本窗后重试，或检查网络/代理环境变量。</p>
  <p>错误：<code>${escapeHtml(opts.errorDescription)}</code> <span class="muted">(${opts.errorCode})</span></p>
  <p>代理：<code>${escapeHtml(opts.proxyLabel)}</code></p>
  <p>目标：<code>${escapeHtml(opts.shopUrl)}</code></p>
  ${
    opts.url && opts.url !== opts.shopUrl
      ? `<p>失败 URL：<code>${escapeHtml(opts.url)}</code></p>`
      : ''
  }
</body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

/** True when HTML looks like the real shop (challenge cleared). */
export function isWafChallengeCleared(status: number, html: string): boolean {
  if (isShopStorefrontHtml(html)) return true
  if (!html.trim()) return false
  if (isShopApiChallengeResponse(status, html)) return false
  const looksHtml = /<!doctype html|<html[\s>]|<\/html>/i.test(html)
  if (!looksHtml) return false
  return html.length > 1500
}

/**
 * Current page must be the target shop URL (prefix from the front).
 * Intermediate WAF redirects to other hosts/paths must not close the window.
 */
export function isOnTargetShopUrl(currentUrl: string, shopUrl: string): boolean {
  try {
    const cur = new URL(currentUrl)
    const target = new URL(shopUrl)
    if (cur.origin.toLowerCase() !== target.origin.toLowerCase()) return false
    const tPath = target.pathname.replace(/\/+$/, '') || ''
    const cPath = cur.pathname
    if (!tPath || tPath === '/') {
      return true
    }
    return cPath === tPath || cPath === `${tPath}/` || cPath.startsWith(`${tPath}/`)
  } catch {
    const base = shopUrl.replace(/\/+$/, '')
    const cur = currentUrl.split('#')[0] ?? ''
    return cur === base || cur === `${base}/` || cur.startsWith(`${base}/`) || cur.startsWith(`${base}?`)
  }
}

async function readPageHtml(win: BrowserWindow): Promise<string> {
  if (win.isDestroyed()) return ''
  try {
    const html = (await win.webContents.executeJavaScript(
      `document.documentElement ? document.documentElement.outerHTML : ''`,
      true
    )) as string
    return typeof html === 'string' ? html : ''
  } catch {
    return ''
  }
}

/**
 * Open a shop window (env proxy if set, else direct); resolve when challenge is cleared
 * (navigation/refresh → storefront) or on timeout / user close / abort.
 */
export async function solveShopWafChallenge(opts: {
  shopUrl: string
  userAgent?: string
  signal?: AbortSignal
  title?: string
}): Promise<WafChallengeResult> {
  if (opts.signal?.aborted) return { ok: false, reason: 'cancelled' }
  if (openCount >= MAX_OPEN) {
    return { ok: false, reason: 'another WAF window is already open' }
  }

  const baseTitle = opts.title ?? '完成人机验证'
  const attempts = buildProxyAttempts()
  let attemptIndex = 0
  let fallbackBusy = false
  let showingErrorPage = false

  const partition = `temp:waf-${Date.now().toString(36)}`
  const ses = session.fromPartition(partition, { cache: false })
  const first = attempts[0]!
  await applyProxyAttempt(ses, first)
  log.info('WAF window open', {
    shopUrl: opts.shopUrl,
    proxy: first.label,
    rules: first.rules ?? null,
    attempts: attempts.map((a) => a.label)
  })

  openCount += 1
  const win = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 720,
    minHeight: 520,
    show: true,
    autoHideMenuBar: true,
    title: `${baseTitle} · 加载中…`,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  if (opts.userAgent) {
    win.webContents.setUserAgent(opts.userAgent)
  }

  return await new Promise<WafChallengeResult>((resolve) => {
    let settled = false
    let checkTimer: ReturnType<typeof setTimeout> | null = null
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null

    const setTitle = (suffix?: string): void => {
      if (win.isDestroyed()) return
      win.setTitle(suffix ? `${baseTitle} · ${suffix}` : baseTitle)
    }

    const currentAttempt = (): ProxyAttempt => attempts[attemptIndex] ?? attempts[attempts.length - 1]!

    const cleanup = (): void => {
      if (checkTimer) clearTimeout(checkTimer)
      if (timeoutTimer) clearTimeout(timeoutTimer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (!win.isDestroyed()) {
        win.removeAllListeners()
        win.webContents.removeAllListeners()
        win.destroy()
      }
      openCount = Math.max(0, openCount - 1)
    }

    const finish = (result: WafChallengeResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    const onAbort = (): void => {
      finish({ ok: false, reason: 'cancelled' })
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    timeoutTimer = setTimeout(() => {
      finish({ ok: false, reason: 'WAF window timed out' })
    }, WAF_TIMEOUT_MS)

    const loadShop = (): void => {
      if (settled || win.isDestroyed()) return
      showingErrorPage = false
      const a = currentAttempt()
      setTitle(`加载中 · ${a.label}`)
      log.info('WAF window loadURL', {
        shopUrl: opts.shopUrl,
        proxy: a.label,
        rules: a.rules ?? null
      })
      void win.loadURL(opts.shopUrl).catch((err) => {
        if (settled || win.isDestroyed()) return
        const msg = err instanceof Error ? err.message : String(err)
        log.warn('WAF window loadURL rejected', { err: msg, proxy: a.label })
        void handleLoadFailure(-1, msg, opts.shopUrl)
      })
    }

    const showFinalError = (errorCode: number, errorDescription: string, url: string): void => {
      if (settled || win.isDestroyed()) return
      const a = currentAttempt()
      setTitle(`加载失败 · ${errorDescription}`)
      showingErrorPage = true
      const dataUrl = loadErrorDataUrl({
        errorCode,
        errorDescription,
        url,
        proxyLabel: a.label,
        shopUrl: opts.shopUrl
      })
      void win.loadURL(dataUrl).catch(() => {
        /* keep window open with last state */
      })
    }

    const handleLoadFailure = async (
      errorCode: number,
      errorDescription: string,
      validatedURL: string
    ): Promise<void> => {
      if (settled || win.isDestroyed() || showingErrorPage) return
      if (errorCode === ERR_ABORTED) return

      const a = currentAttempt()
      log.warn('WAF window load failed', {
        errorCode,
        errorDescription,
        url: validatedURL,
        proxy: a.label,
        rules: a.rules ?? null,
        attemptIndex,
        attemptsLeft: attempts.length - attemptIndex - 1
      })

      if (fallbackBusy) return
      if (attemptIndex < attempts.length - 1) {
        fallbackBusy = true
        attemptIndex += 1
        const next = currentAttempt()
        try {
          await applyProxyAttempt(ses, next)
          log.info('WAF window proxy fallback', {
            from: a.label,
            to: next.label,
            rules: next.rules ?? null
          })
          loadShop()
        } catch (err) {
          log.warn('WAF window proxy fallback apply failed', {
            err: err instanceof Error ? err.message : String(err),
            to: next.label
          })
          showFinalError(
            errorCode,
            errorDescription,
            validatedURL || opts.shopUrl
          )
        } finally {
          fallbackBusy = false
        }
        return
      }

      showFinalError(errorCode, errorDescription, validatedURL || opts.shopUrl)
    }

    const scheduleCheck = (): void => {
      if (settled || win.isDestroyed() || showingErrorPage) return
      if (checkTimer) clearTimeout(checkTimer)
      checkTimer = setTimeout(() => {
        void (async () => {
          if (settled || win.isDestroyed() || showingErrorPage) return
          const currentUrl = win.webContents.getURL()
          if (!isOnTargetShopUrl(currentUrl, opts.shopUrl)) {
            return
          }
          const html = await readPageHtml(win)
          if (!isWafChallengeCleared(200, html)) return
          try {
            const list = await ses.cookies.get({ url: opts.shopUrl })
            const cookies = list.map((c) => ({ name: c.name, value: c.value }))
            log.info('WAF challenge cleared', {
              cookies: cookies.map((c) => c.name),
              htmlLen: html.length,
              url: currentUrl,
              proxy: currentAttempt().label
            })
            finish({ ok: true, cookies, node: null })
          } catch (err) {
            finish({
              ok: false,
              reason: err instanceof Error ? err.message : String(err)
            })
          }
        })()
      }, CHECK_DEBOUNCE_MS)
    }

    win.webContents.on('did-start-loading', () => {
      if (settled || showingErrorPage) return
      setTitle(`加载中 · ${currentAttempt().label}`)
    })

    win.webContents.on('did-stop-loading', () => {
      if (settled || win.isDestroyed() || showingErrorPage) return
      setTitle(currentAttempt().label)
      scheduleCheck()
    })

    win.webContents.on(
      'did-fail-load',
      (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) return
        void handleLoadFailure(errorCode, errorDescription, validatedURL)
      }
    )

    win.webContents.on('did-navigate', () => scheduleCheck())
    win.webContents.on('did-navigate-in-page', () => scheduleCheck())
    win.webContents.on('did-finish-load', () => {
      if (showingErrorPage) return
      setTitle(currentAttempt().label)
      scheduleCheck()
    })
    win.webContents.on('did-frame-finish-load', (_e, isMain) => {
      if (isMain) scheduleCheck()
    })

    win.on('closed', () => {
      finish({ ok: false, reason: 'WAF window closed' })
    })

    loadShop()
  })
}
