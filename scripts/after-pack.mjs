/**
 * electron-builder afterPack:裁剪运行时不需要的 Chromium 附属文件,减小安装体积。
 * 本应用无 WebGPU / 软件 Vulkan 需求;保留 ffmpeg 等常规渲染依赖。
 */
import { rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** @param {import('electron-builder').AfterPackContext} context */
export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  const dir = context.appOutDir
  // WebGPU 着色器编译 / 软件 Vulkan —— 产品路径未使用
  const optional = [
    'dxcompiler.dll',
    'dxil.dll',
    'vk_swiftshader.dll',
    'vk_swiftshader_icd.json',
    'vulkan-1.dll'
  ]

  for (const name of optional) {
    const p = join(dir, name)
    if (!existsSync(p)) continue
    rmSync(p)
    console.log(`[after-pack] removed ${name}`)
  }
}
