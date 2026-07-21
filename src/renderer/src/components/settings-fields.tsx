import type { ReactNode } from 'react'
import { Input } from './ui'

/** 单行设置项：左侧 label + 说明，右侧控件 */
export function SettingsRow({
  label,
  desc,
  children
}: {
  label?: string
  desc?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="settings-row">
      <div className="s-main">
        {label ? <div className="s-label">{label}</div> : null}
        {desc ? <div className={`s-desc${label ? '' : ' is-solo'}`}>{desc}</div> : null}
      </div>
      <div className="s-ctrl">{children}</div>
    </div>
  )
}

/** 数字输入：失焦提交，非法值回退(key 随 value 变化重挂载，无需状态同步) */
export function NumberField({
  value,
  min,
  max,
  disabled,
  onCommit
}: {
  value: number
  min: number
  max?: number
  disabled?: boolean
  onCommit: (v: number) => void
}): React.JSX.Element {
  return (
    <Input
      key={value}
      type="number"
      min={min}
      max={max}
      disabled={disabled}
      defaultValue={value}
      onBlur={(e) => {
        const v = Number(e.target.value)
        const inMax = max == null || v <= max
        if (Number.isFinite(v) && v >= min && inMax && v !== value) onCommit(v)
        else e.target.value = String(value)
      }}
    />
  )
}
