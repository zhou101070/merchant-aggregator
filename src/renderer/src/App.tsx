import { useEffect } from 'react'
import { Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom'
import { SearchPage } from './pages/SearchPage'
import { MerchantsPage } from './pages/MerchantsPage'
import { FavoritesPage } from './pages/FavoritesPage'
import { SyncCenterPage } from './pages/SyncCenterPage'
import { SettingsPage } from './pages/SettingsPage'
import { ConfirmProvider } from './components/dialog'
import { ToastProvider } from './components/toast'
import { Icon } from './components/icons'
import { IconButton, Kbd, Progress } from './components/ui'
import { useSyncStatus } from './hooks/useSync'
import { formatSyncProgress, jobTypeLabel } from './lib/sync-labels'
import { timeAgo } from './lib/format-time'
import { focusSearchInput } from './lib/focus-search'
import './styles/app.css'

function SyncWidget(): React.JSX.Element {
  const navigate = useNavigate()
  const { status, progress, busy, cancelRunning } = useSyncStatus()
  const job = progress?.status === 'running' ? progress : status?.running[0]

  const lastSync = Object.values(status?.lastSuccessAt ?? {})
    .filter(Boolean)
    .sort()
    .pop()

  return (
    <button
      type="button"
      className="sync-widget"
      onClick={() => navigate('/sync')}
      title="打开同步中心"
    >
      {busy && job ? (
        <>
          <span className="sync-title">
            <span>{jobTypeLabel(job.jobType)}</span>
            <IconButton
              label="取消同步"
              onClick={(e) => {
                e.stopPropagation()
                void cancelRunning()
              }}
            >
              <Icon name="close" size={13} />
            </IconButton>
          </span>
          <Progress current={job.current ?? 0} total={job.total ?? 0} indeterminate={!job.total} />
          <span className="sync-line">{formatSyncProgress(job)}</span>
        </>
      ) : (
        <>
          <span className="sync-counts">
            <span>商家</span>
            <span className="num">{status?.counts.merchants ?? 0}</span>
            <span>ldxp</span>
            <span className="num">{status?.counts.ldxpMerchants ?? 0}</span>
            <span>店内商品</span>
            <span className="num">{status?.counts.shopProducts ?? 0}</span>
          </span>
          <span className="sync-line">
            {lastSync ? `上次同步 ${timeAgo(lastSync)}` : '尚未同步'}
          </span>
        </>
      )}
    </button>
  )
}

export default function App(): React.JSX.Element {
  const navigate = useNavigate()

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        navigate('/')
        focusSearchInput()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
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
                  <Kbd>⌘K</Kbd>
                </span>
              </NavLink>
              <NavLink to="/merchants">
                <Icon name="store" />
                商家
              </NavLink>
              <NavLink to="/favorites">
                <Icon name="bookmark" />
                收藏
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
            <main className="content">
              <Routes>
                <Route path="/" element={<SearchPage />} />
                <Route path="/search" element={<Navigate to="/" replace />} />
                <Route path="/merchants" element={<MerchantsPage />} />
                <Route path="/favorites" element={<FavoritesPage />} />
                <Route path="/sync" element={<SyncCenterPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </main>
          </div>
        </div>
      </ConfirmProvider>
    </ToastProvider>
  )
}
