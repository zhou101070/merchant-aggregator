import { StatusDot } from './ui'
import { healthLabel, healthTone } from '../lib/health'

export function HealthStatus({
  health,
  prefix
}: {
  health: string | null | undefined
  /** e.g. "同步：" */
  prefix?: string
}): React.JSX.Element {
  return (
    <StatusDot tone={healthTone(health)}>
      {prefix}
      {healthLabel(health)}
    </StatusDot>
  )
}
