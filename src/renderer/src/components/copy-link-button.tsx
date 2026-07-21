import { useEffect, useRef, useState } from 'react'
import { Icon } from './icons'
import { IconButton } from './ui'
import { useToast } from './use-toast'

const RESET_MS = 3000

/**
 * 复制链接图标按钮：成功后变绿对号，3s 后恢复；失败 toast。
 */
export function CopyLinkButton({
  url,
  size = 14,
  stopPropagation
}: {
  url: string
  size?: number
  stopPropagation?: boolean
}): React.JSX.Element {
  const toast = useToast()
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  async function onClick(e: React.MouseEvent): Promise<void> {
    if (stopPropagation) e.stopPropagation()
    const text = url.trim()
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), RESET_MS)
    } catch {
      toast('复制失败，请检查剪贴板权限', 'fail')
    }
  }

  return (
    <IconButton
      label={copied ? '已复制' : '复制链接'}
      className={copied ? 'copy-ok' : undefined}
      onClick={(e) => void onClick(e)}
    >
      <Icon name={copied ? 'check' : 'copy'} size={size} />
    </IconButton>
  )
}
