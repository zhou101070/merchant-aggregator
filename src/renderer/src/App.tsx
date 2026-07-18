import { useEffect } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { ConfirmProvider } from './components/dialog'
import { KeepAlivePages } from './components/keep-alive-pages'
import { ToastProvider } from './components/toast'
import { WindowControls } from './components/window-controls'
import { Icon } from './components/icons'
import { IconButton, Kbd, Progress } from './components/ui'
import { useSyncStatus } from './hooks/useSync'
import { formatSyncProgress, jobTypeLabel } from './lib/sync-labels'
import { timeAgo } from './lib/format-time'
import { focusSearchInput } from './lib/focus-search'
import { searchHotkeyLabel } from './lib/mod-key'
import './styles/app.css'

function SyncWidget(): React.JSX.Element {
  const navigate = useNavigate()
  const { status, progress, busy, cancelRunning } = useSyncStatus()
  const job = progress?.status === 'running' ? progress : status?.running[0]

  const lastSync = Object.values(status?.lastSuccessAt ?? {})
    .filter(Boolean)
    .sort()
    .pop()

  // Outer is a div (not button) so cancel IconButton is not nested interactive.
  return (
    <div className="sync-widget">
      {busy && job ? (
        <>
          <span className="sync-title">
            <button
              type="button"
              className="sync-widget-hit"
              onClick={() => navigate('/sync')}
              title="打开同步中心"
            >
              {jobTypeLabel(job.jobType)}
            </button>
            <IconButton label="取消同步" onClick={() => void cancelRunning()}>
              <Icon name="close" size={14} />
            </IconButton>
          </span>
          <button
            type="button"
            className="sync-widget-hit"
            onClick={() => navigate('/sync')}
            title="打开同步中心"
          >
            <Progress current={job.current ?? 0} total={job.total ?? 0} indeterminate={!job.total} />
            <span className="sync-line">{formatSyncProgress(job)}</span>
          </button>
        </>
      ) : (
        <button
          type="button"
          className="sync-widget-hit"
          onClick={() => navigate('/sync')}
          title="打开同步中心"
        >
          <span className="sync-counts">
            <span>商家</span>
            <span className="num">{status?.counts.merchants ?? 0}</span>
            <span>可刮</span>
            <span className="num">
              {status?.counts.scrapableMerchants ?? status?.counts.ldxpMerchants ?? 0}
            </span>
            <span>店内商品</span>
            <span className="num">{status?.counts.shopProducts ?? 0}</span>
          </span>
          <span className="sync-line">
            {lastSync ? `上次同步 ${timeAgo(lastSync)}` : '尚未同步'}
          </span>
        </button>
      )}
    </div>
  )
}

export default function App(): React.JSX.Element {
  const navigate = useNavigate()

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 输入法组字中不抢快捷键
      if (e.isComposing || e.key === 'Process') return
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      if (e.key.toLowerCase() !== 'k') return
      e.preventDefault()
      e.stopPropagation()
      navigate('/')
      focusSearchInput()
    }
    // capture：优先于页面内 keydown，避免被搜索页方向键等处理截断
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [navigate])

  return (
    <ToastProvider>
      <ConfirmProvider>
        <div className="app">
          <aside className="sidebar">
            <div className="brand">
              <span className="brand-mark" aria-hidden="true" />
              Merchant Aggregator
            </div>
            <nav className="nav">
              <NavLink to="/" end>
                <Icon name="search" />
                搜索
                <span className="nav-kbd">
                  <Kbd>{searchHotkeyLabel()}</Kbd>
                </span>
              </NavLink>
              <NavLink to="/merchants">
                <Icon name="store" />
                商家
              </NavLink>
              <NavLink to="/favorites">
                <Icon name="bookmark" />
                收藏与最近
              </NavLink>
              <NavLink to="/sync">
                <Icon name="sync" />
                同步
              </NavLink>
              <NavLink to="/settings">
                <Icon name="sliders" />
                设置
              </NavLink>
            </nav>
            <div className="side-foot">
              <SyncWidget />
            </div>
          </aside>
          <div className="main">
            <div className="drag-strip" aria-hidden="true" />
            <WindowControls />
            <main className="content">
              <KeepAlivePages />
            </main>
          </div>
        </div>
      </ConfirmProvider>
    </ToastProvider>
  )
}
