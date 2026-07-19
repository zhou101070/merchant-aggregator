import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type HTMLAttributes,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { runDialogLeave } from '../lib/dialog-leave'
import { wrappedFocusIndex } from './modal-focus'
import { ModalDismissContext } from './use-modal-dismiss'

const ModalTitleIdContext = createContext<string | null>(null)
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

type ModalStackEntry = {
  root: HTMLDivElement
  panel: HTMLDivElement
  opener: HTMLElement | null
}

const modalStack: ModalStackEntry[] = []
const backgroundInert = new Map<HTMLElement, boolean>()
let bodyObserver: MutationObserver | null = null

function syncModalInert(): void {
  const top = modalStack[modalStack.length - 1]
  if (!top) {
    bodyObserver?.disconnect()
    bodyObserver = null
    for (const [element, inert] of backgroundInert) {
      if (element.isConnected) element.inert = inert
    }
    backgroundInert.clear()
    return
  }

  const roots = new Set(modalStack.map((entry) => entry.root))
  for (const child of document.body.children) {
    if (!(child instanceof HTMLElement)) continue
    if (roots.has(child as HTMLDivElement)) {
      child.inert = child !== top.root
      continue
    }
    if (!backgroundInert.has(child)) backgroundInert.set(child, child.inert)
    child.inert = true
  }

  if (!bodyObserver) {
    bodyObserver = new MutationObserver(syncModalInert)
    bodyObserver.observe(document.body, { childList: true })
  }
}

function isTopModal(entry: ModalStackEntry | null): boolean {
  return Boolean(entry && modalStack[modalStack.length - 1] === entry)
}

function visibleFocusableElements(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) => !element.closest('[inert]') && element.getClientRects().length > 0
  )
}

function canRestoreFocus(element: HTMLElement | null): element is HTMLElement {
  return Boolean(
    element?.isConnected &&
      !element.closest('[inert]') &&
      element.getClientRects().length > 0
  )
}

export function ModalDialogTitle({
  children,
  ...props
}: HTMLAttributes<HTMLHeadingElement>): React.JSX.Element {
  const titleId = useContext(ModalTitleIdContext)
  return (
    <h2 {...props} id={titleId ?? props.id}>
      {children}
    </h2>
  )
}

/**
 * 自绘模态层（不用原生 <dialog>.showModal）。
 * 每次挂载 = 打开；父级卸载本组件 = 关闭。
 * 各页面各自 portal 到 body，实例互不共享。
 */
function dialogPanelClass(className?: string): string {
  const parts = (className ?? 'dialog dialog-wide').trim().split(/\s+/).filter(Boolean)
  if (!parts.includes('dialog')) parts.unshift('dialog')
  return parts.join(' ')
}

export function ModalDialog({
  openKey,
  className = 'dialog dialog-wide',
  onClose,
  children
}: {
  /** 切换时仅用于 key 语义（焦点/无障碍），不驱动开关 */
  openKey: string
  className?: string
  onClose: () => void
  children: ReactNode
}): React.JSX.Element {
  const panelClass = dialogPanelClass(className)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const closedRef = useRef(false)
  const leavingRef = useRef(false)
  const onCloseRef = useRef(onClose)
  const titleId = useId()
  const entryRef = useRef<ModalStackEntry | null>(null)
  const openerRef = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  )

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  const finishClose = useCallback((): void => {
    if (closedRef.current) return
    closedRef.current = true
    leavingRef.current = false
    onCloseRef.current()
  }, [])

  const dismiss = useCallback((): void => {
    if (closedRef.current || leavingRef.current) return
    if (!isTopModal(entryRef.current)) return
    const panel = panelRef.current
    if (!panel) {
      finishClose()
      return
    }
    leavingRef.current = true
    // 同步给 root 加 class，方便 backdrop 一起淡出
    rootRef.current?.classList.add('leaving')
    runDialogLeave(panel, finishClose)
  }, [finishClose])

  useLayoutEffect(() => {
    const root = rootRef.current
    const panel = panelRef.current
    if (!root || !panel) return
    const entry: ModalStackEntry = { root, panel, opener: openerRef.current }
    entryRef.current = entry
    modalStack.push(entry)
    syncModalInert()

    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !panel.contains(active)) {
      const focusable = visibleFocusableElements(panel)
      ;(focusable[0] ?? panel).focus({ preventScroll: true })
    }

    return () => {
      const wasTop = isTopModal(entry)
      const index = modalStack.indexOf(entry)
      if (index >= 0) modalStack.splice(index, 1)
      entryRef.current = null
      syncModalInert()
      if (!wasTop) return
      window.setTimeout(() => {
        if (canRestoreFocus(entry.opener)) {
          entry.opener.focus({ preventScroll: true })
          return
        }
        const nextTop = modalStack[modalStack.length - 1]
        nextTop?.panel.focus({ preventScroll: true })
      }, 0)
    }
  }, [])

  // Only the top custom modal owns Escape / Tab. Native dialogs keep priority.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const entry = entryRef.current
      if (!isTopModal(entry)) return
      if (e.target instanceof Element && e.target.closest('dialog[open]')) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        dismiss()
        return
      }
      if (e.key === 'Tab' && entry) {
        const focusable = visibleFocusableElements(entry.panel)
        const activeIndex =
          document.activeElement instanceof HTMLElement
            ? focusable.indexOf(document.activeElement)
            : -1
        const nextIndex = wrappedFocusIndex(focusable.length, activeIndex, e.shiftKey)
        e.preventDefault()
        e.stopPropagation()
        ;(nextIndex >= 0 ? focusable[nextIndex] : entry.panel).focus({ preventScroll: true })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [dismiss])

  // Switching the displayed entity keeps focus inside the existing modal shell.
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const active = document.activeElement
    if (active && panel.contains(active)) return
    const focusable = visibleFocusableElements(panel)
    ;(focusable[0] ?? panel).focus({ preventScroll: true })
  }, [openKey])

  return createPortal(
    <div
      ref={rootRef}
      className="modal-root"
      data-modal-open="true"
      data-open-key={openKey}
      role="presentation"
    >
      <div
        className="modal-backdrop"
        aria-hidden="true"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) dismiss()
        }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={panelClass}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <ModalTitleIdContext.Provider value={titleId}>
          <ModalDismissContext.Provider value={dismiss}>{children}</ModalDismissContext.Provider>
        </ModalTitleIdContext.Provider>
      </div>
    </div>,
    document.body
  )
}
