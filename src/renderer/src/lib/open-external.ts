export async function openExternalSafe(url: string | null | undefined): Promise<void> {
  if (!url) return
  await window.api.shell.openExternal(url)
}
