import { createContext, useContext } from 'react'

export interface ConfirmSpec {
  title: string
  body: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

export type ConfirmFn = (spec: ConfirmSpec) => Promise<boolean>

export const ConfirmContext = createContext<ConfirmFn | null>(null)

/** Promise 风格确认对话框(原生 <dialog>，替换 window.confirm)。 */
export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext)
  if (!fn) throw new Error('useConfirm must be used within <ConfirmProvider>')
  return fn
}
