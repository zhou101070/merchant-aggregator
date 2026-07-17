/** 输入是否可聚焦（不在 hidden 的 keep-alive 页内） */
function canFocus(el: HTMLElement): boolean {
  if (el.closest('[hidden]')) return false
  // offsetParent 为 null 时多为 display:none；fixed 元素例外，用 checkVisibility 优先
  if (typeof el.checkVisibility === 'function') {
    try {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    } catch {
      /* fall through */
    }
  }
  return el.getClientRects().length > 0
}

/**
 * ⌘K / Ctrl+K 目标：聚焦搜索首页主输入框（SearchPage 以 data-search-input 标记）。
 * 从其他 keep-alive 路由切回时，需等 React 去掉 hidden 后再 focus，故带短重试。
 */
export function focusSearchInput(): void {
  const maxTries = 30
  const attempt = (n: number): void => {
    const el = document.querySelector<HTMLInputElement>('[data-search-input]')
    if (el && canFocus(el)) {
      el.focus()
      el.select()
      return
    }
    if (n < maxTries) {
      requestAnimationFrame(() => attempt(n + 1))
    }
  }
  requestAnimationFrame(() => attempt(0))
}
