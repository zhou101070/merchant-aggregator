import { useEffect, useState, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { onDataCleared } from '../lib/data-events'
import { SearchPage } from '../pages/SearchPage'
import { MerchantsPage } from '../pages/MerchantsPage'
import { FavoritesPage } from '../pages/FavoritesPage'
import { SyncCenterPage } from '../pages/SyncCenterPage'
import { SettingsPage } from '../pages/SettingsPage'

type PageDef = {
  key: string
  match: (pathname: string) => boolean
  element: ReactNode
}

const PAGES: PageDef[] = [
  { key: '/', match: (p) => p === '/', element: <SearchPage /> },
  { key: '/merchants', match: (p) => p.startsWith('/merchants'), element: <MerchantsPage /> },
  { key: '/favorites', match: (p) => p.startsWith('/favorites'), element: <FavoritesPage /> },
  { key: '/sync', match: (p) => p.startsWith('/sync'), element: <SyncCenterPage /> },
  { key: '/settings', match: (p) => p.startsWith('/settings'), element: <SettingsPage /> }
]

function pageKey(pathname: string): string | null {
  return PAGES.find((p) => p.match(pathname))?.key ?? null
}

export function KeepAlivePages(): React.JSX.Element {
  const { pathname } = useLocation()
  const active = pageKey(pathname)
  const [seen, setSeen] = useState<Set<string>>(() => new Set(active ? [active] : ['/']))
  /** Bump after data wipe so keep-alive pages remount with empty state. */
  const [dataEpoch, setDataEpoch] = useState(0)

  useEffect(() => {
    if (!active) return
    setSeen((prev) => (prev.has(active) ? prev : new Set(prev).add(active)))
  }, [active])

  useEffect(() => {
    return onDataCleared(() => {
      setDataEpoch((n) => n + 1)
      setSeen(new Set(active ? [active] : ['/']))
    })
  }, [active])

  // /search 与未知路径：hooks 之后再 redirect，避免 Rules of Hooks 崩溃
  if (pathname === '/search' || !active) return <Navigate to="/" replace />

  return (
    <>
      {PAGES.map((page) => {
        if (!seen.has(page.key)) return null
        const on = page.match(pathname)
        return (
          <div
            key={`${page.key}-e${dataEpoch}`}
            className={`route-alive${on ? ' is-active' : ''}`}
            aria-hidden={!on}
            inert={!on || undefined}
          >
            {page.element}
          </div>
        )
      })}
    </>
  )
}
