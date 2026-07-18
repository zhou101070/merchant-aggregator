import type { CSSProperties, PropsWithChildren, ReactNode } from 'react'

export function PageHeader({
  title,
  meta,
  actions
}: {
  title: string
  meta?: ReactNode
  actions?: ReactNode
}): React.JSX.Element {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        {meta != null && meta !== false ? <div className="page-meta">{meta}</div> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  )
}

export function PanelHeader({
  title,
  sub,
  actions,
  style,
  children
}: PropsWithChildren<{
  title?: ReactNode
  sub?: ReactNode
  actions?: ReactNode
  style?: CSSProperties
}>): React.JSX.Element {
  return (
    <div className="panel-head" style={style}>
      {children ?? (
        <>
          {title != null ? <strong>{title}</strong> : null}
          {sub != null && sub !== '' ? <span className="sub">{sub}</span> : null}
        </>
      )}
      {actions}
    </div>
  )
}

export function FilterBar({
  label,
  children,
  style,
  className
}: PropsWithChildren<{
  label?: string
  style?: CSSProperties
  className?: string
}>): React.JSX.Element {
  return (
    <div className={`filter-bar${className ? ` ${className}` : ''}`} style={style}>
      {label ? <span className="lab">{label}</span> : null}
      {children}
    </div>
  )
}
