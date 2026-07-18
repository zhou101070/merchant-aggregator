import type { ConfirmFn, ConfirmSpec } from '../components/use-confirm'

let impl: ConfirmFn | null = null

/** ConfirmProvider 挂载时注册，供非 React 调用点使用 */
export function setAppConfirm(fn: ConfirmFn | null): void {
  impl = fn
}

export async function appConfirm(spec: ConfirmSpec): Promise<boolean> {
  if (!impl) return false
  return impl(spec)
}
