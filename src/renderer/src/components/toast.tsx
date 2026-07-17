import { useCallback, useRef, useState, type PropsWithChildren } from 'react'
import { ToastContext, type ToastFn } from './use-toast'
import type { Tone } from './ui'

interface ToastItem {
  id: number
  message: string
  tone: Tone
  leaving: boolean
}

const DURATION = 4000
const LEAVE = 220

export function ToastProvider({ children }: PropsWithChildren): React.JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([])
  const idRef = useRef(0)

  const toast = useCallback<ToastFn>((message, tone = 'default') => {
    const id = ++idRef.current
    setItems((prev) => [...prev.slice(-3), { id, message, tone, leaving: false }])
    window.setTimeout(() => {
      setItems((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)))
    }, DURATION - LEAVE)
    window.setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id))
    }, DURATION)
  }, [])

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toaster" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.leaving ? 'leaving' : ''}`}>
            {t.tone !== 'default' ? <i className={`dot ${t.tone}`} aria-hidden="true" /> : null}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
