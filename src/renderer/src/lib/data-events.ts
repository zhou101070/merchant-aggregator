/** Fired after local business data wipe so keep-alive pages remount / reload. */
export const DATA_CLEARED_EVENT = 'ma:data-cleared'

export function emitDataCleared(): void {
  window.dispatchEvent(new Event(DATA_CLEARED_EVENT))
}

export function onDataCleared(cb: () => void): () => void {
  const handler = (): void => {
    cb()
  }
  window.addEventListener(DATA_CLEARED_EVENT, handler)
  return () => window.removeEventListener(DATA_CLEARED_EVENT, handler)
}
