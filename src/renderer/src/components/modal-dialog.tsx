import { useCallback, useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ModalDismissContext } from './use-modal-dismiss'

/** Native <dialog> shell: showModal, closedRef guard, portal to body. */
export function ModalDialog({
  openKey,
  className = 'dialog dialog-wide',
  onClose,
  children
}: {
  /** Remount / re-show when this changes (merchant id, job id, …) */
  openKey: string
  className?: string
  onClose: () => void
  children: ReactNode
}): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closedRef = useRef(false)
  const onCloseRef = useRef(onClose)

  useLayoutEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  const dismiss = useCallback((): void => {
    if (closedRef.current) return
    closedRef.current = true
    const el = dialogRef.current
    if (el?.open) el.close()
    onCloseRef.current()
  }, [])

  useLayoutEffect(() => {
    const el = dialogRef.current
    if (!el) return
    closedRef.current = false
    try {
      if (!el.open) el.showModal()
    } catch {
      el.setAttribute('open', '')
    }
  }, [openKey])

  return createPortal(
    <dialog
      ref={dialogRef}
      className={className}
      onClose={() => {
        if (closedRef.current) return
        closedRef.current = true
        onCloseRef.current()
      }}
      onCancel={(e) => {
        e.preventDefault()
        dismiss()
      }}
    >
      <ModalDismissContext.Provider value={dismiss}>{children}</ModalDismissContext.Provider>
    </dialog>,
    document.body
  )
}
