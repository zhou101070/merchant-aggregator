import { useCallback, useEffect, useRef, useState, type PropsWithChildren } from 'react'
import { setAppConfirm } from '../lib/confirm-bridge'
import { runDialogLeave } from '../lib/dialog-leave'
import { ConfirmContext, type ConfirmFn, type ConfirmSpec } from './use-confirm'
import { Button } from './ui'

export function ConfirmProvider({ children }: PropsWithChildren): React.JSX.Element {
  const [spec, setSpec] = useState<ConfirmSpec | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const pendingRef = useRef<((ok: boolean) => void) | null>(null)
  const settlingRef = useRef(false)
  const closedByUsRef = useRef(false)

  const confirm = useCallback<ConfirmFn>((next) => {
    // 已有未决确认时，先取消旧的(工具场景不排队)
    pendingRef.current?.(false)
    return new Promise<boolean>((resolve) => {
      pendingRef.current = resolve
      settlingRef.current = false
      closedByUsRef.current = false
      setSpec(next)
    })
  }, [])

  useEffect(() => {
    setAppConfirm(confirm)
    return () => setAppConfirm(null)
  }, [confirm])

  useEffect(() => {
    if (spec && dialogRef.current && !dialogRef.current.open) {
      dialogRef.current.classList.remove('leaving')
      dialogRef.current.showModal()
    }
  }, [spec])

  function finishClose(): void {
    closedByUsRef.current = true
    dialogRef.current?.close()
    setSpec(null)
    settlingRef.current = false
    closedByUsRef.current = false
  }

  function settle(ok: boolean): void {
    if (settlingRef.current) return
    settlingRef.current = true
    const resolve = pendingRef.current
    pendingRef.current = null
    resolve?.(ok)

    const el = dialogRef.current
    if (!el?.open) {
      setSpec(null)
      settlingRef.current = false
      return
    }
    runDialogLeave(el, finishClose)
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {spec ? (
        <dialog
          ref={dialogRef}
          className="dialog"
          onClose={() => {
            if (closedByUsRef.current) return
            settle(false)
          }}
          onCancel={(e) => {
            e.preventDefault()
            settle(false)
          }}
        >
          <div className="dialog-body">
            <h2 className="dialog-title">{spec.title}</h2>
            <p className="dialog-text">{spec.body}</p>
          </div>
          <div className="dialog-actions">
            <Button onClick={() => settle(false)}>{spec.cancelLabel ?? '取消'}</Button>
            <Button
              variant={spec.danger ? 'danger' : 'primary'}
              autoFocus
              onClick={() => settle(true)}
            >
              {spec.confirmLabel ?? '确定'}
            </Button>
          </div>
        </dialog>
      ) : null}
    </ConfirmContext.Provider>
  )
}
