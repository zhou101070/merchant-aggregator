/** Sync failures only block a merchant when the user explicitly enabled that policy. */
export function shouldBlockMerchantAfterSyncFailure(opts: {
  enabled: boolean
  code: string
  notFamily: boolean
  merchantId: string | null
}): boolean {
  return opts.enabled && opts.code !== 'CANCELLED' && !opts.notFamily && Boolean(opts.merchantId)
}
