/**
 * 跨平台测试入口(package.json "test"):
 * better-sqlite3 需先切到 Node ABI 才能在 vitest 里加载,跑完无论成败都切回 Electron ABI。
 * 原实现依赖 POSIX shell 语法(`; status=$?; exit $status`),Windows cmd 下无法执行,故改为 Node 脚本。
 */
import { spawnSync } from 'node:child_process'

function run(command) {
  console.log(`\n> ${command}`)
  const { status } = spawnSync(command, { stdio: 'inherit', shell: true })
  return status ?? 1
}

// 透传测试筛选参数:pnpm test src/main/services
const filters = process.argv
  .slice(2)
  .map((arg) => `"${arg}"`)
  .join(' ')

let status = run('pnpm run rebuild:native:node')
if (status === 0) status = run(filters ? `vitest run ${filters}` : 'vitest run')

// 与原脚本语义一致:恢复失败不改变测试退出码(dev 脚本启动时会重新 rebuild,自愈)
run('pnpm run rebuild:native:electron')

process.exit(status)
