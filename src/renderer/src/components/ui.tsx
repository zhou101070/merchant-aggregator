import type { ButtonHTMLAttributes, InputHTMLAttributes, PropsWithChildren, ReactNode } from 'react'

/* ---------------- Button ---------------- */

export function Button({
  variant = 'default',
  size = 'default',
  loading,
  className,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger' | 'ok'
  size?: 'default' | 's'
  loading?: boolean
}): React.JSX.Element {
  const cls = [
    'btn',
    variant !== 'default' ? `btn-${variant}` : '',
    size === 's' ? 'btn-s' : '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <button {...props} className={cls} disabled={disabled || loading}>
      {loading ? <span className="spin" aria-hidden="true" /> : null}
      {children}
    </button>
  )
}

export function IconButton({
  label,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }): React.JSX.Element {
  return (
    <button {...props} className={`icon-btn ${className ?? ''}`} aria-label={label} title={label}>
      {children}
    </button>
  )
}

/* ---------------- 表单控件 ---------------- */

export function Input(props: InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  const { className, ...rest } = props
  return <input {...rest} className={`input ${className ?? ''}`} />
}

export function Switch({
  checked,
  onChange,
  disabled,
  label
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label?: string
}): React.JSX.Element {
  return (
    <span className="switch">
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="track" aria-hidden="true" />
      <span className="thumb" aria-hidden="true" />
    </span>
  )
}

/* ---------------- 状态展示 ---------------- */

export type Tone = 'default' | 'ok' | 'fail' | 'warn' | 'brass'

export function Badge({
  tone = 'default',
  children
}: PropsWithChildren<{ tone?: Tone }>): React.JSX.Element {
  return <span className={`badge ${tone === 'default' ? '' : tone}`}>{children}</span>
}

export function StatusDot({
  tone = 'default',
  children,
  title
}: PropsWithChildren<{ tone?: Tone; title?: string }>): React.JSX.Element {
  return (
    <span className="status" title={title}>
      <i className={`dot ${tone === 'default' ? '' : tone}`} aria-hidden="true" />
      {children}
    </span>
  )
}

export function Chip({
  on,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { on?: boolean }): React.JSX.Element {
  return (
    <button type="button" {...props} className={`chip ${on ? 'on' : ''}`} aria-pressed={on}>
      {children}
    </button>
  )
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label
}: {
  /** null = none selected (e.g. column sort outside toolbar options) */
  value: T | null
  onChange: (v: T) => void
  options: { value: T; label: string }[]
  label?: string
}): React.JSX.Element {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={o.value === value ? 'on' : ''}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Kbd({ children }: PropsWithChildren): React.JSX.Element {
  return <kbd className="kbd">{children}</kbd>
}

export function Progress({
  current,
  total,
  indeterminate
}: {
  current?: number
  total?: number
  indeterminate?: boolean
}): React.JSX.Element {
  const ratio =
    !indeterminate && total && total > 0 ? Math.min(1, Math.max(0, (current ?? 0) / total)) : 0
  return (
    <div
      className={`progress ${indeterminate ? 'indet' : ''}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total ?? undefined}
      aria-valuenow={indeterminate ? undefined : current}
    >
      <div className="bar" style={{ '--p': ratio } as React.CSSProperties} />
    </div>
  )
}

/* ---------------- 价格(数据签名) ---------------- */

export function Price({
  price,
  currency,
  lowest
}: {
  price: number | null | undefined
  currency?: string | null
  lowest?: boolean
}): React.JSX.Element {
  if (price == null || !Number.isFinite(price)) return <span className="faint">—</span>
  return (
    <span className={`price ${lowest ? 'lowest' : ''}`}>
      <span className="cur">{currency ?? 'CNY'}</span>
      <span className="amt">{price.toFixed(2)}</span>
    </span>
  )
}

export function LowFlag(): React.JSX.Element {
  return (
    <span className="low-flag">
      <i className="dot brass" aria-hidden="true" />
      最低
    </span>
  )
}

/* ---------------- 空态 / 骨架 ---------------- */

export function Empty({
  title,
  actions,
  children
}: PropsWithChildren<{ title: string; actions?: ReactNode }>): React.JSX.Element {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {actions ? <div className="empty-actions">{actions}</div> : null}
    </div>
  )
}

export function SkeletonRows({ rows = 5 }: { rows?: number }): React.JSX.Element {
  return (
    <div className="stack" style={{ padding: 16, gap: 14 }} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skel" style={{ width: `${88 - ((i * 13) % 34)}%` }} />
      ))}
    </div>
  )
}
