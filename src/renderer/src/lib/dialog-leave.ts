/** Match tokens.css --dur-3; fallback if transitionend never fires. */
const LEAVE_MS = 280
const LEAVE_FALLBACK_MS = LEAVE_MS + 40

/**
 * Play dialog leave class, then invoke done (close / unmount).
 * Reduced-motion skips wait; concurrent calls are ignored via .leaving.
 */
export function runDialogLeave(el: HTMLElement, done: () => void): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    done()
    return
  }
  if (el.classList.contains('leaving')) return

  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    el.removeEventListener('transitionend', onEnd)
    window.clearTimeout(timer)
    done()
  }
  const onEnd = (e: TransitionEvent): void => {
    if (e.target !== el) return
    if (e.propertyName !== 'opacity') return
    finish()
  }

  el.addEventListener('transitionend', onEnd)
  // Ensure transition runs from current computed style
  void el.offsetWidth
  el.classList.add('leaving')
  const timer = window.setTimeout(finish, LEAVE_FALLBACK_MS)
}
