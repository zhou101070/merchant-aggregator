import { createContext, useContext } from 'react'
import type { Tone } from './ui'

export type ToastFn = (message: string, tone?: Tone) => void

export const ToastContext = createContext<ToastFn | null>(null)

/** 轻量操作回执(替换页面内 flash banner)。4s 自动消失。 */
export function useToast(): ToastFn {
  const fn = useContext(ToastContext)
  if (!fn) throw new Error('useToast must be used within <ToastProvider>')
  return fn
}
