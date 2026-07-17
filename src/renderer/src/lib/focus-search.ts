/** ⌘K 目标：聚焦搜索首页的主输入框(SearchPage 以 data-search-input 标记)。 */
export function focusSearchInput(): void {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLInputElement>('[data-search-input]')
    el?.focus()
    el?.select()
  })
}
