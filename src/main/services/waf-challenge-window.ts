/**
 * Interactive WAF / captcha window.
 *
 * The window deliberately uses Electron's default session: the foreground
 * retry performed after this flow must see the same cookies and browser state
 * as the API requests. It never changes proxy settings or creates a second
 * cookie jar.
 */
import { BrowserWindow, session } from 'electron'
import {
  isShopApiChallengeResponse,
  isShopStorefrontHtml
} from '../platforms/shopapi/challenge'
import { resolveRequestUserAgent } from '../utils/request-headers'

const WAF_TIMEOUT_MS = 5 * 60_000
const CHECK_DEBOUNCE_MS = 400
const CHECK_POLL_MS = 1_000
/** Chromium net::ERR_ABORTED — common on redirects / superseding navigations. */
const ERR_ABORTED = -3
let openCount = 0
const MAX_OPEN = 1

export type WafChallengeCookie = { name: string; value: string }

export type WafChallengeResult =
  | { ok: true; cookies: WafChallengeCookie[]; node: string | null }
  | { ok: false; reason: string }

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
    if (!tPath || tPath === '/') return true
    return cPath === tPath || cPath === `${tPath}/` || cPath.startsWith(`${tPath}/`)
  } catch {
    const base = shopUrl.replace(/\/+$/, '')
    const cur = currentUrl.split('#')[0] ?? ''
    return cur === base || cur === `${base}/` || cur.startsWith(`${base}/`) || cur.startsWith(`${base}?`)
  }
}

async function readPageState(win: BrowserWindow): Promise<{ status: number; html: string }> {
  if (win.isDestroyed()) return { status: 0, html: '' }
  try {
    const state = (await win.webContents.executeJavaScript(
      `(() => {
        const nav = performance.getEntriesByType('navigation')[0]
        const status = nav && typeof nav.responseStatus === 'number' ? nav.responseStatus : 200
        return {
          status,
          html: document.documentElement ? document.documentElement.outerHTML : ''
        }
      })()`,
      true
    )) as { status?: unknown; html?: unknown }
    return {
      status: typeof state?.status === 'number' ? state.status : 200,
      html: typeof state?.html === 'string' ? state.html : ''
    }
  } catch {
    return { status: 0, html: '' }
  }
}

/** Open the target page and resolve after the user clears the challenge. */
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
  const ses = session.defaultSession
  const ua = resolveRequestUserAgent(opts.userAgent)
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
  win.webContents.setUserAgent(ua)

  return await new Promise<WafChallengeResult>((resolve) => {
    let settled = false
    let checkTimer: ReturnType<typeof setTimeout> | null = null
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null

    const setTitle = (suffix?: string): void => {
      if (!win.isDestroyed()) win.setTitle(suffix ? `${baseTitle} · ${suffix}` : baseTitle)
    }

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

    const onAbort = (): void => finish({ ok: false, reason: 'cancelled' })
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    timeoutTimer = setTimeout(() => {
      finish({ ok: false, reason: 'WAF window timed out' })
    }, WAF_TIMEOUT_MS)

    const scheduleCheck = (delay = CHECK_DEBOUNCE_MS): void => {
      if (settled || win.isDestroyed()) return
      if (checkTimer) clearTimeout(checkTimer)
      checkTimer = setTimeout(() => {
        void (async () => {
          if (settled || win.isDestroyed()) return
          const currentUrl = win.webContents.getURL()
          if (isOnTargetShopUrl(currentUrl, opts.shopUrl)) {
            const state = await readPageState(win)
            if (isWafChallengeCleared(state.status, state.html)) {
              try {
                const cookies = await ses.cookies.get({ url: opts.shopUrl })
                finish({
                  ok: true,
                  cookies: cookies.map((c) => ({ name: c.name, value: c.value })),
                  node: null
                })
              } catch (err) {
                finish({
                  ok: false,
                  reason: err instanceof Error ? err.message : String(err)
                })
              }
              return
            }
            setTitle('请在此窗口完成验证')
          }
          scheduleCheck(CHECK_POLL_MS)
        })()
      }, delay)
    }

    win.webContents.on('did-start-loading', () => setTitle('加载中…'))
    win.webContents.on('did-stop-loading', () => scheduleCheck())
    win.webContents.on('did-navigate', () => scheduleCheck())
    win.webContents.on('did-navigate-in-page', () => scheduleCheck())
    win.webContents.on('did-finish-load', () => scheduleCheck())
    win.webContents.on('did-frame-finish-load', (_event, isMainFrame) => {
      if (isMainFrame) scheduleCheck()
    })
    win.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === ERR_ABORTED || settled) return
        finish({ ok: false, reason: `${errorDescription} (${errorCode})` })
      }
    )
    win.on('closed', () => finish({ ok: false, reason: 'WAF window closed' }))

    void win.loadURL(opts.shopUrl).catch((err) => {
      if (settled || win.isDestroyed()) return
      finish({ ok: false, reason: err instanceof Error ? err.message : String(err) })
    })
  })
}
