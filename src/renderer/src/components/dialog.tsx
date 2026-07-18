import { useCallback, useEffect, useRef, useState, type PropsWithChildren } from 'react'
import { setAppConfirm } from '../lib/confirm-bridge'
import { ConfirmContext, type ConfirmFn, type ConfirmSpec } from './use-confirm'
import { Button } from './ui'

export function ConfirmProvider({ children }: PropsWithChildren): React.JSX.Element {
  const [spec, setSpec] = useState<ConfirmSpec | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const pendingRef = useRef<((ok: boolean) => void) | null>(null)

  const confirm = useCallback<ConfirmFn>((next) => {
    // 已有未决确认时，先取消旧的(工具场景不排队)
    pendingRef.current?.(false)
    return new Promise<boolean>((resolve) => {
      pendingRef.current = resolve
      setSpec(next)
    })
  }, [])

  useEffect(() => {
    setAppConfirm(confirm)
    return () => setAppConfirm(null)
  }, [confirm])

  useEffect(() => {
    if (spec && dialogRef.current && !dialogRef.current.open) {
      dialogRef.current.showModal()
    }
  }, [spec])

  function settle(ok: boolean): void {
    const resolve = pendingRef.current
    pendingRef.current = null
    resolve?.(ok)
    dialogRef.current?.close()
    setSpec(null)
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {spec ? (
        <dialog
          ref={dialogRef}
          className="dialog"
          onClose={() => settle(false)}
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
