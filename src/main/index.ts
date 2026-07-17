import { app, shell, BrowserWindow, ipcMain, nativeTheme, nativeImage } from 'electron'
import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import type Database from 'better-sqlite3'
import {
  closeDatabase,
  openDatabase,
  resolveUserDataDbPath,
  createRepositories,
  type Repositories
} from './db'
import { registerIpcHandlers } from './ipc/register'
import { SyncOrchestrator } from './services/sync-orchestrator'
import { SearchService } from './services/search-service'
import { createLogger } from './utils/logger'
import { ensureSystemProxy } from './utils/main-fetch'

const log = createLogger('main')

let db: Database.Database | null = null
let repos: Repositories | null = null
let sync: SyncOrchestrator | null = null
let search: SearchService | null = null

/** 与 tokens.css 中 --bg 对齐,避免启动/主题切换白闪(DESIGN.md §2) */
function themeBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#0f0e0c' : '#f8f7f4'
}

/**
 * 设计审查截图钩子(dev 工具),逐路由截图后自动退出:
 * POSIX:      MA_SCREENSHOT_DIR=/path MA_THEME=dark|light pnpm dev
 * PowerShell: $env:MA_SCREENSHOT_DIR='D:\shots'; $env:MA_THEME='dark'; pnpm dev
 */
async function runScreenshotMode(win: BrowserWindow, dir: string): Promise<void> {
  // 深链一个真实 ldxp 商家,截到主从详情态
  const detailId = await win.webContents
    .executeJavaScript(
      `window.api.merchants
        .list({ limit: 50, sort: 'offerCount', sortDir: 'desc' })
        .then((r) => {
          const rows = Array.isArray(r) ? r : (r.rows ?? [])
          const hit = rows.find((m) => m.ldxpToken && m.localProductCount > 0) ?? rows[0]
          return hit ? hit.id : ''
        })
        .catch(() => '')`
    )
    .catch(() => '')
  const routes: Array<[string, string, string?]> = [
    ['search', '/'],
    ['search-results', '/?q=claude'],
    ['merchants', '/merchants'],
    ...(detailId ? [['merchants-detail', `/merchants?id=${detailId}`] as [string, string]] : []),
    // 下拉展开态:点开商家页的状态筛选
    ['merchants-select-open', '/merchants', `document.querySelector('button.select')?.click()`],
    ['favorites', '/favorites'],
    ['sync', '/sync'],
    ['settings', '/settings']
  ]
  const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  await mkdir(dir, { recursive: true })
  for (const [name, route, interact] of routes) {
    // 路由含查询参数时需整体替换 hash;先清空确保重新挂载(参数仅在挂载时读取)
    await win.webContents.executeJavaScript(
      `location.hash = '#/__blank'; setTimeout(() => (location.hash = ${JSON.stringify(`#${route}`)}), 50)`
    )
    await new Promise((r) => setTimeout(r, 900))
    if (interact) {
      await win.webContents.executeJavaScript(interact)
      await new Promise((r) => setTimeout(r, 400))
    }
    const image = await win.webContents.capturePage()
    await writeFile(join(dir, `${theme}-${name}.png`), image.toPNG())
  }
  log.info('screenshot mode done', { dir, theme })
  app.quit()
}

/**
 * 开发态图标：
 * - macOS：打包前没有 .icns，需 dock.setIcon；图需自带 squircle + 透明边
 * - Windows / Linux：BrowserWindow.icon 控制窗口与任务栏
 */
function loadAppIcon(): Electron.NativeImage | null {
  const image = nativeImage.createFromPath(icon)
  if (image.isEmpty()) {
    log.warn('app icon empty', { icon })
    return null
  }
  return image
}

function createWindow(): void {
  const appIcon = loadAppIcon()
  if (process.platform === 'darwin' && appIcon) {
    app.dock?.setIcon(appIcon)
  }

  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: themeBackground(),
    // Win/Linux 任务栏与窗口图标；macOS 窗口忽略此项，已用 dock.setIcon
    ...(appIcon && process.platform !== 'darwin' ? { icon: appIcon } : {}),
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  nativeTheme.on('updated', () => {
    if (!mainWindow.isDestroyed()) mainWindow.setBackgroundColor(themeBackground())
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    const shotDir = process.env['MA_SCREENSHOT_DIR']
    if (shotDir) void runScreenshotMode(mainWindow, shotDir)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function initDatabase(): void {
  const filePath = resolveUserDataDbPath(app.getPath('userData'))
  const opened = openDatabase({ filePath })
  db = opened.db
  repos = createRepositories(db)
  sync = new SyncOrchestrator(repos)
  search = new SearchService(db)
  registerIpcHandlers({ repos, sync, search })
  log.info('database ready', {
    filePath: opened.filePath,
    schemaVersion: opened.schemaVersion,
    foreignKeys: opened.foreignKeys,
    merchants: repos.merchants.count(),
    shopProducts: repos.shopProducts.count()
  })
}

app.whenReady().then(() => {
  // Windows 任务栏分组 / 通知图标身份（须与 electron-builder appId 一致时更稳）
  electronApp.setAppUserModelId('com.merchant-aggregator')

  const forcedTheme = process.env['MA_THEME']
  if (forcedTheme === 'dark' || forcedTheme === 'light') {
    nativeTheme.themeSource = forcedTheme
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.on('ping', () => log.debug('pong'))

  try {
    initDatabase()
  } catch (err) {
    log.error('failed to open database', err)
    app.quit()
    return
  }

  void ensureSystemProxy()
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  closeDatabase(db)
  db = null
  repos = null
  sync = null
  search = null
})
