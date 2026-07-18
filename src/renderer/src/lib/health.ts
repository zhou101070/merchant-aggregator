import type { Tone } from '../components/ui'

export function healthTone(h: string | null | undefined): Tone {
  if (h === 'healthy') return 'ok'
  if (h === 'failing') return 'fail'
  if (h === 'retrying' || h === 'never') return 'warn'
  return 'default'
}

export function healthLabel(h: string | null | undefined): string {
  switch (h) {
    case 'healthy':
      return '健康'
    case 'failing':
      return '异常'
    case 'retrying':
      return '同步中'
    case 'never':
      return '未同步'
    case 'n/a':
      return '不适用'
    case 'unknown':
      return '未知'
    default:
      return h?.trim() ? h : '未同步'
  }
}
