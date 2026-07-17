import { useEffect, useId, useRef, useState } from 'react'
import { Icon } from './icons'

/**
 * 统一下拉(DESIGN.md §6):全自绘,不使用原生弹出菜单。
 * 触发器与 Input 同规格;面板为顶层 popover,CSS 锚定(block-end,
 * 空间不足自动上翻,宽度 ≥ 触发器),不受容器 overflow 裁剪。
 * ARIA select-only combobox 模式:焦点始终在触发器,aria-activedescendant 指示活动项。
 */

export interface SelectOption<V extends string = string> {
  value: V
  label: string
  disabled?: boolean
}

interface SelectProps<V extends string> {
  value: V
  options: readonly SelectOption<V>[]
  onValueChange: (value: V) => void
  /** 无可见 label 的场景必填,保证可达性 */
  ariaLabel: string
  disabled?: boolean
  className?: string
}

export function Select<V extends string>({
  value,
  options,
  onValueChange,
  ariaLabel,
  disabled,
  className
}: SelectProps<V>): React.JSX.Element {
  const popRef = useRef<HTMLDivElement>(null)
  const typeRef = useRef({ buf: '', at: 0 })
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const id = useId()
  const popId = `${id}-pop`
  const optId = (i: number): string => `${id}-opt-${i}`

  const selectedIndex = options.findIndex((o) => o.value === value)
  const selectedLabel = selectedIndex >= 0 ? options[selectedIndex].label : ''

  /** 从 from 沿 dir 找下一个可用项;越界则原地不动 */
  const step = (from: number, dir: 1 | -1): number => {
    for (let i = from + dir; i >= 0 && i < options.length; i += dir) {
      if (!options[i].disabled) return i
    }
    return from
  }
  const edge = (dir: 1 | -1): number => {
    const from = dir === 1 ? -1 : options.length
    return step(from, dir)
  }

  const commit = (i: number): void => {
    const o = options[i]
    if (!o || o.disabled) return
    popRef.current?.hidePopover()
    if (o.value !== value) onValueChange(o.value)
  }

  /** popover 开合(点击触发器 / 点旁边 / Esc 均由平台光解散驱动)统一在此同步状态 */
  const onToggle = (e: React.ToggleEvent<HTMLDivElement>): void => {
    const opening = e.newState === 'open'
    setOpen(opening)
    if (opening) setActive(selectedIndex >= 0 ? selectedIndex : edge(1))
  }

  // 键盘活动项保持可见
  useEffect(() => {
    if (open && active >= 0) {
      document.getElementById(optId(active))?.scrollIntoView({ block: 'nearest' })
    }
    // optId 仅依赖 useId,稳定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active])

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (!open) {
      // Enter / Space 走原生 popovertarget 点击;方向键需手动展开
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        popRef.current?.showPopover()
      }
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => step(a, e.key === 'ArrowDown' ? 1 : -1))
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      setActive(edge(e.key === 'Home' ? 1 : -1))
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      commit(active)
    } else if (e.key === 'Tab') {
      popRef.current?.hidePopover() // 不提交,焦点自然移走(Esc 由光解散处理)
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // 字符前缀跳转:短时间连击累积为前缀,单字符则从下一项起循环找
      const st = typeRef.current
      st.buf = e.timeStamp - st.at > 700 ? e.key : st.buf + e.key
      st.at = e.timeStamp
      const q = st.buf.toLowerCase()
      const from = st.buf.length === 1 ? active + 1 : active
      for (let k = 0; k < options.length; k++) {
        const i = (from + k + options.length) % options.length
        if (!options[i].disabled && options[i].label.toLowerCase().startsWith(q)) {
          setActive(i)
          break
        }
      }
    }
  }

  return (
    <>
      <button
        type="button"
        className={`select ${className ?? ''}`}
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={popId}
        aria-activedescendant={open && active >= 0 ? optId(active) : undefined}
        aria-label={ariaLabel}
        popoverTarget={popId}
        onKeyDown={onKeyDown}
      >
        <span className="select-value">{selectedLabel}</span>
        <Icon name="chevronDown" size={14} className="select-chevron" />
      </button>
      <div
        ref={popRef}
        id={popId}
        className="select-pop"
        popover="auto"
        role="listbox"
        aria-label={ariaLabel}
        onToggle={onToggle}
        onMouseDown={(e) => e.preventDefault() /* 焦点留在触发器 */}
      >
        {options.map((o, i) => (
          <div
            key={o.value}
            id={optId(i)}
            role="option"
            aria-selected={o.value === value}
            aria-disabled={o.disabled || undefined}
            data-active={i === active || undefined}
            className="select-opt"
            onMouseEnter={o.disabled ? undefined : () => setActive(i)}
            onClick={() => commit(i)}
          >
            <Icon name="check" size={14} className="select-opt-check" />
            <span className="select-opt-label">{o.label}</span>
          </div>
        ))}
      </div>
    </>
  )
}
