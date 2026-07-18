/**
 * Keep a real Chromium document open on the shop origin and run API calls via
 * page-context fetch (same cookies / Sec-Fetch / TLS stack as a normal browser tab).
 * On WAF: open system default browser (user Chrome often passes), then reload in-app tab.
 */
import { createLogger } from '../../utils/logger'
import { ensureSystemProxy } from '../../utils/main-fetch'
import { beginSyncHttpRequest, endSyncHttpRequest } from '../../services/sync-request-log'
import { evaluateOpenExternal } from '../../utils/url-safety'
import { isShopApiChallengeResponse, isShopStorefrontHtml } from './challenge'

const log = createLogger('shopapi:browser-session')

export type PageFetchResult = { status: number; text: string }

/** One browser window at a time across shops (WAF + focus). */
let lock: Promise<unknown> = Promise.resolve()

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn)
  lock = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelledError())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(cancelledError())
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
  })
}

function cancelledError(): Error {
  const err = new Error('shop page session cancelled')
  err.name = 'AbortError'
  return err
}

function looksLikeChallengeHtml(html: string): boolean {
  if (isShopStorefrontHtml(html)) return false
  return isShopApiChallengeResponse(200, html) || isShopApiChallengeResponse(403, html)
}

/** Positive: shop UI painted (user screenshot case — already past WAF). */
async function pageLooksLikeStorefront(win: Electron.BrowserWindow): Promise<boolean> {
  try {
    const hit = await win.webContents.executeJavaScript(
      `(() => {
        const t = (document.body && document.body.innerText) ? document.body.innerText : '';
        if (/商品列表|店铺公告|商品分类|卡密\\s*\\(|库存充足|库存少量|Powered by/.test(t) && t.length > 40) {
          return true;
        }
        const html = document.documentElement ? document.documentElement.outerHTML : '';
        return /商品列表|店铺公告|商品分类/.test(html);
      })()`,
      true
    )
    return hit === true
  } catch {
    return false
  }
}

export class ShopPageSession {
  private win: Electron.BrowserWindow | null = null
  private origin = ''

  get isOpen(): boolean {
    return Boolean(this.win && !this.win.isDestroyed())
  }

  /**
   * Load shop page in a hidden app tab.
   * If WAF blocks: open system browser (no wait) and return cleared=false so the
   * shop queue can scrape other shops first, then retry this one later.
   */
  async open(options: {
    shopUrl: string
    userAgent: string
    /** How long to wait for storefront before treating as WAF (default 12s) */
    autoTimeoutMs?: number
    /** Open OS browser when blocked (default true) */
    openSystemBrowserOnWaf?: boolean
    signal?: AbortSignal
  }): Promise<{ cleared: boolean; mode: 'auto' | 'system_browser' }> {
    return withLock(() => this.openUnlocked(options))
  }

  private async openUnlocked(options: {
    shopUrl: string
    userAgent: string
    autoTimeoutMs?: number
    openSystemBrowserOnWaf?: boolean
    signal?: AbortSignal
  }): Promise<{ cleared: boolean; mode: 'auto' | 'system_browser' }> {
    if (options.signal?.aborted) throw cancelledError()
    await this.close()

    // defaultSession proxy is applied lazily by mainFetch; page-context fetch in this
    // window never calls it, so make sure the embedded core proxy is active first.
    await ensureSystemProxy()

    const electron = await import('electron')
    const { BrowserWindow, session } = electron
    const autoTimeoutMs = options.autoTimeoutMs ?? 12_000
    const openSystemBrowserOnWaf = options.openSystemBrowserOnWaf !== false
    const signal = options.signal

    this.origin = new URL(options.shopUrl).origin

    const win = new BrowserWindow({
      show: false,
      width: 960,
      height: 720,
      autoHideMenuBar: true,
      title: '店铺同步',
      webPreferences: {
        session: session.defaultSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    })
    this.win = win
    win.webContents.setUserAgent(options.userAgent)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    const onAbort = (): void => {
      void this.close()
    }
    signal?.addEventListener('abort', onAbort)

    try {
      if (signal?.aborted) throw cancelledError()
      log.info('open shop page session', { url: options.shopUrl })
      try {
        await win.loadURL(options.shopUrl)
      } catch (err) {
        if (signal?.aborted || win.isDestroyed()) throw cancelledError()
        throw err
      }

      let mode: 'auto' | 'system_browser' = 'auto'
      const cleared = await this.waitUntilClear(Date.now() + autoTimeoutMs, signal)

      // 不过检：系统浏览器打开后立刻返回，由队列延后重试（不阻塞后续店）
      if (!cleared && openSystemBrowserOnWaf) {
        if (signal?.aborted) throw cancelledError()
        mode = 'system_browser'
        const opened = await openShopInSystemBrowser(options.shopUrl)
        log.info('WAF: system browser opened, defer shop', { url: options.shopUrl, opened })
      }

      log.info('shop page session ready', { cleared, mode, origin: this.origin })
      return { cleared, mode }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Same-origin POST as the SPA would (credentials included).
   * Must be called after open(); serialized with global lock per call batch via caller limiter.
   */
  async postJson(path: string, body: Record<string, unknown>, visitorId: string): Promise<PageFetchResult> {
    const win = this.win
    if (!win || win.isDestroyed()) {
      throw new Error('shop page session not open')
    }
    const url = path.startsWith('http') ? path : `${this.origin}${path.startsWith('/') ? '' : '/'}${path}`
    const bodyJson = JSON.stringify(body)
    const logId = beginSyncHttpRequest({ method: 'POST', url })

    // Run fetch in page world — not Node/Electron net — matches real browser XHR.
    try {
      const result = (await win.webContents.executeJavaScript(
        `(() => {
          const url = ${JSON.stringify(url)};
          const body = ${JSON.stringify(bodyJson)};
          const visitorId = ${JSON.stringify(visitorId)};
          return fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json, text/plain, */*',
              Visitorid: visitorId
            },
            body,
            credentials: 'include'
          }).then(async (res) => {
            const text = await res.text();
            return { status: res.status, text: String(text || '') };
          }).catch((err) => ({
            status: 0,
            text: String(err && err.message ? err.message : err)
          }));
        })()`,
        true
      )) as PageFetchResult

      const status = typeof result?.status === 'number' ? result.status : 0
      const text = typeof result?.text === 'string' ? result.text : ''
      if (status === 0) {
        endSyncHttpRequest(logId, { status: 0, error: text || 'page fetch failed' })
      } else {
        endSyncHttpRequest(logId, { status })
      }
      return { status, text }
    } catch (err) {
      endSyncHttpRequest(logId, {
        status: null,
        error: err instanceof Error ? err.message : String(err)
      })
      throw err
    }
  }

  async readCookies(): Promise<Array<{ name: string; value: string }>> {
    const win = this.win
    if (!win || win.isDestroyed() || !this.origin) return []
    try {
      const list = await win.webContents.session.cookies.get({ url: this.origin + '/' })
      return list.map((c) => ({ name: c.name, value: c.value }))
    } catch {
      return []
    }
  }

  async close(): Promise<void> {
    const win = this.win
    this.win = null
    if (win && !win.isDestroyed()) {
      try {
        win.destroy()
      } catch {
        // ignore
      }
    }
  }

  private async waitUntilClear(deadlineMs: number, signal?: AbortSignal): Promise<boolean> {
    const win = this.win
    if (!win) return false
    while (Date.now() < deadlineMs) {
      if (signal?.aborted) throw cancelledError()
      if (win.isDestroyed()) {
        if (signal?.aborted) throw cancelledError()
        return false
      }
      try {
        // Prefer positive storefront detection (avoids SPA false WAF hits)
        if (await pageLooksLikeStorefront(win)) {
          await sleep(200, signal)
          return true
        }
        const html = await win.webContents.executeJavaScript(
          'document.documentElement ? document.documentElement.outerHTML.slice(0, 16000) : ""',
          true
        )
        const text = typeof html === 'string' ? html : ''
        if (text && !looksLikeChallengeHtml(text) && text.length > 400) {
          await sleep(300, signal)
          return true
        }
        const cookies = await win.webContents.session.cookies.get({
          url: win.webContents.getURL() || this.origin
        })
        if (cookies.some((c) => /^(acw_sc__v2|acw_tc)$/i.test(c.name))) {
          await sleep(400, signal)
          if (await pageLooksLikeStorefront(win)) return true
        }
      } catch (err) {
        if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
          throw cancelledError()
        }
        // navigating
      }
      await sleep(350, signal)
    }
    return false
  }
}

/** Rolling budget so a burst of WAF shops does not open dozens of tabs. */
const SYSTEM_BROWSER_BUDGET = { max: 5, windowMs: 10 * 60_000 }
let systemBrowserOpens = 0
let systemBrowserWindowStart = 0

/** Open shop URL in the OS default browser (https only). Budgeted. */
async function openShopInSystemBrowser(shopUrl: string): Promise<boolean> {
  const now = Date.now()
  if (now - systemBrowserWindowStart > SYSTEM_BROWSER_BUDGET.windowMs) {
    systemBrowserOpens = 0
    systemBrowserWindowStart = now
  }
  if (systemBrowserOpens >= SYSTEM_BROWSER_BUDGET.max) {
    log.info('system browser open budget exhausted', {
      max: SYSTEM_BROWSER_BUDGET.max,
      opens: systemBrowserOpens
    })
    return false
  }
  try {
    const decision = evaluateOpenExternal(shopUrl)
    if (decision.action === 'reject') return false
    const { shell } = await import('electron')
    await shell.openExternal(shopUrl)
    systemBrowserOpens += 1
    return true
  } catch (err) {
    log.warn('system browser open failed', { err: String(err) })
    return false
  }
}
