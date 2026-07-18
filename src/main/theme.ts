import { nativeTheme } from 'electron'
import type { ThemeMode } from '@shared/types/settings'

/**
 * 将设置中的主题应用到 nativeTheme。
 * MA_THEME=dark|light(截图钩子)优先,不写回设置。
 */
export function applyThemeSource(mode: ThemeMode): void {
  const forced = process.env['MA_THEME']
  if (forced === 'dark' || forced === 'light') {
    nativeTheme.themeSource = forced
    return
  }
  nativeTheme.themeSource = mode
}
