/**
 * 在 macOS 上交叉打包 Windows x64 安装包。
 *
 * 关键点:better-sqlite3 是 native 模块,默认 postinstall 编的是本机 (darwin) 二进制。
 * 打包前必须换成 win32-x64 + Electron ABI 的预编译 .node,装包后数据库才能加载;
 * 打包结束无论成败都恢复本机 Electron ABI,避免打断后续 `pnpm dev`。
 *
 * electron-builder 的 npmRebuild:false 是刻意的:由本脚本显式控制跨平台 rebuild,
 * 避免 builder 在打包流程里隐式改写 node_modules。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function run(command) {
  console.log(`\n> ${command}`)
  const { status } = spawnSync(command, { stdio: 'inherit', shell: true, cwd: root })
  return status ?? 1
}

function electronVersion() {
  const pkg = JSON.parse(readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8'))
  return pkg.version
}

const electronVer = electronVersion()

// 1) 编译 main/preload/renderer
let status = run('pnpm run build')

// 2) 拉取 win32-x64 Electron ABI 的 better-sqlite3 预编译二进制
if (status === 0) {
  status = run(
    `pnpm exec electron-rebuild -f -o better-sqlite3 --platform win32 --arch x64 -v ${electronVer}`
  )
}

// 3) 打 Windows x64 NSIS 安装包(与 electron-builder.yml win.target 一致)
if (status === 0) {
  status = run('pnpm exec electron-builder --win --x64')
}

// 恢复本机 Electron native,失败不覆盖打包退出码
const restore = run('pnpm run rebuild:native:electron')
if (restore !== 0) {
  console.warn(
    '\n[build-win] 警告:打包后恢复 better-sqlite3 为本机 Electron ABI 失败,请手动执行: pnpm run rebuild:native:electron'
  )
}

process.exit(status)
