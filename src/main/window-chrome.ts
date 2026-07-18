import { BrowserWindow, nativeTheme } from 'electron'

/** 自绘标题栏高度（Win）；渲染层用 --titlebar-h 对齐 */
export const TITLEBAR_HEIGHT = 36

/** @deprecated 使用 TITLEBAR_HEIGHT */
export const TITLEBAR_OVERLAY_HEIGHT = TITLEBAR_HEIGHT

/**
 * 窗口铬色与 tokens.css 对齐,避免标题栏/内容「两层皮」(DESIGN.md §2 / §8.3)
 * hex 为 OKLCH 令牌的近似值,仅主进程 BrowserWindow API 使用。
 */
export function baseThemeChrome(): { background: string; symbol: string } {
  if (nativeTheme.shouldUseDarkColors) {
    return { background: '#0f0e0c', symbol: '#eae8e3' }
  }
  return { background: '#f8f7f4', symbol: '#1d1a14' }
}

export function applyWindowChrome(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const base = baseThemeChrome()
  win.setBackgroundColor(base.background)
}

export function applyWindowChromeAll(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    applyWindowChrome(win)
  }
}
