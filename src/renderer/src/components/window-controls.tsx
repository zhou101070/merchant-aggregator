import { useEffect, useState } from 'react'

function Glyph({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className="window-ctrl-glyph">
      {children}
    </svg>
  )
}

/** Windows 自绘窗控：最小化 / 最大化·还原 / 关闭。弹窗蒙层可盖住。 */
export function WindowControls(): React.JSX.Element | null {
  const [maximized, setMaximized] = useState(false)
  const isWin = typeof document !== 'undefined' && document.documentElement.dataset.platform === 'win32'

  useEffect(() => {
    if (!isWin) return
    void window.api.window.isMaximized().then(setMaximized)
    return window.api.window.onMaximized(setMaximized)
  }, [isWin])

  if (!isWin) return null

  return (
    <div className="window-controls" role="toolbar" aria-label="窗口控制">
      <button
        type="button"
        className="window-ctrl"
        aria-label="最小化"
        title="最小化"
        onClick={() => void window.api.window.minimize()}
      >
        <Glyph>
          <path d="M1 5h8" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </Glyph>
      </button>
      <button
        type="button"
        className="window-ctrl"
        aria-label={maximized ? '还原' : '最大化'}
        title={maximized ? '还原' : '最大化'}
        onClick={() => void window.api.window.maximizeToggle()}
      >
        {maximized ? (
          <Glyph>
            <path
              d="M2.5 3.5h4v4h-4zM3.5 2.5h4v1M7.5 2.5v4h-1"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.1"
            />
          </Glyph>
        ) : (
          <Glyph>
            <rect
              x="1.5"
              y="1.5"
              width="7"
              height="7"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
            />
          </Glyph>
        )}
      </button>
      <button
        type="button"
        className="window-ctrl window-ctrl-close"
        aria-label="关闭"
        title="关闭"
        onClick={() => void window.api.window.close()}
      >
        <Glyph>
          <path d="M2 2l6 6M8 2L2 8" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </Glyph>
      </button>
    </div>
  )
}
