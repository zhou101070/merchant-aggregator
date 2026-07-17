/** 修饰键文案：Mac ⌘，Win/Linux Ctrl */
export function modKeyLabel(): string {
  return document.documentElement.dataset.platform === 'darwin' ? '⌘' : 'Ctrl'
}

/** 聚焦搜索快捷键展示 */
export function searchHotkeyLabel(): string {
  const mod = modKeyLabel()
  return mod === '⌘' ? '⌘K' : `${mod}+K`
}
