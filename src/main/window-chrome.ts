import { BrowserWindow, nativeTheme } from 'electron'

/** Windows 标题栏叠层高度;渲染层用 env(titlebar-area-height) 对齐 */
export const TITLEBAR_OVERLAY_HEIGHT = 36

/** 与 dialog::backdrop `oklch(0 0 0 / 45%)` 对齐 */
const BACKDROP_BLACK_ALPHA = 0.45

let dialogOverlayActive = false

/**
 * 窗口铬色与 tokens.css 对齐,避免标题栏/内容「两层皮」(DESIGN.md §2 / §8.3)
 * hex 为 OKLCH 令牌的近似值,仅主进程 BrowserWindow API 使用。
 */
export function baseThemeChrome(): { background: string; symbol: string } {
  if (nativeTheme.shouldUseDarkColors) {
    // --bg / --ink 深色
    return { background: '#0f0e0c', symbol: '#eae8e3' }
  }
  // --bg / --ink 浅色
  return { background: '#f8f7f4', symbol: '#1d1a14' }
}

function mixWithBlack(hex: string, blackAlpha: number): string {
  const n = hex.replace('#', '')
  const r = parseInt(n.slice(0, 2), 16)
  const g = parseInt(n.slice(2, 4), 16)
  const b = parseInt(n.slice(4, 6), 16)
  const keep = 1 - blackAlpha
  const to = (c: number): string =>
    Math.round(c * keep)
      .toString(16)
      .padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

export function applyWindowChrome(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const base = baseThemeChrome()
  win.setBackgroundColor(base.background)
  if (process.platform === 'win32') {
    const color = dialogOverlayActive
      ? mixWithBlack(base.background, BACKDROP_BLACK_ALPHA)
      : base.background
    win.setTitleBarOverlay({
      color,
      symbolColor: base.symbol,
      height: TITLEBAR_OVERLAY_HEIGHT
    })
  }
}

export function applyWindowChromeAll(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    applyWindowChrome(win)
  }
}

/** Win WCO 在网页之上,弹窗蒙层盖不住窗控;用叠层色模拟蒙层延伸 */
export function setDialogOverlayActive(active: boolean): void {
  if (dialogOverlayActive === active) return
  dialogOverlayActive = active
  applyWindowChromeAll()
}
