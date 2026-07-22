/** Sync failures only block a merchant when the user explicitly enabled that policy. */
export function shouldBlockMerchantAfterSyncFailure(opts: {
  enabled: boolean
  code: string
  notFamily: boolean
  merchantId: string | null
  /** Unknown-platform all-modes-failed: never auto-block. */
  silentUnknown?: boolean
}): boolean {
  return (
    opts.enabled &&
    opts.code !== 'CANCELLED' &&
    opts.code !== 'NEED_BROWSER' &&
    opts.code !== 'RATE_LIMIT' &&
    !opts.notFamily &&
    !opts.silentUnknown &&
    Boolean(opts.merchantId)
  )
}
