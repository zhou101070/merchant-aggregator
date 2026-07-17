export async function openExternalSafe(url: string | null | undefined): Promise<void> {
  if (!url) return
  const res = await window.api.shell.openExternal(url)
  if (!res.ok && res.needsConfirm) {
    const ok = window.confirm(`打开非白名单站点 ${res.host}？\n${url}`)
    if (ok) await window.api.shell.openExternal(url, { confirmed: true })
  }
}
