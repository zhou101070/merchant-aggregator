/**
 * 同步类长任务的确认文案(供 useConfirm 使用，见 DESIGN.md §8.2)。
 */
import type { ConfirmSpec } from '../components/use-confirm'

/** 一键初始化：商家 + Top-N 店铺。 */
export function bootstrapSpec(): ConfirmSpec {
  return {
    title: '一键初始化',
    body:
      '同步商家列表（PriceAI / NodeBits），再按全局平台识别深刮报价数 Top 50 的可刮店铺。\n' +
      '将访问 priceai.cc、nodebits.xyz 与已注册发卡网，可能需要十几分钟，可随时取消。',
    confirmLabel: '开始同步'
  }
}

/** 全量 / 旧数据店铺深刮（可刮 = shop_platform + shop_token 且 profile.enabled）。 */
function formatFreshThreshold(minutes: number): string {
  const m = Math.max(1, Math.floor(minutes))
  if (m % 60 === 0) {
    const h = m / 60
    return `${h} 小时`
  }
  if (m > 60) {
    const h = Math.floor(m / 60)
    const rest = m % 60
    return rest ? `${h} 小时 ${rest} 分钟` : `${h} 小时`
  }
  return `${m} 分钟`
}

export function shopAllSpec(
  count: number,
  opts?: { force?: boolean; freshMinutes?: number; /** @deprecated use freshMinutes */ freshHours?: number }
): ConfirmSpec {
  const n = Math.max(0, count)
  const minutes =
    opts?.freshMinutes != null && opts.freshMinutes > 0
      ? Math.floor(opts.freshMinutes)
      : opts?.freshHours != null && opts.freshHours > 0
        ? Math.floor(opts.freshHours * 60)
        : null
  return {
    title: opts?.force ? '强制全量同步店铺' : '同步旧数据店铺',
    body:
      (opts?.force
        ? `将强制重刮全部约 ${n} 家可深刮店铺（忽略旧数据阈值）。`
        : minutes != null
          ? `将只同步超过 ${formatFreshThreshold(minutes)} 未成功更新的可深刮店铺（池内最多约 ${n} 家，实际以过期店为准）。`
          : `将只同步超过「旧数据阈值」的可深刮店铺（池内最多约 ${n} 家）。`) +
      '\n串行访问已启用发卡网，可能需要较长时间，可随时取消。',
    confirmLabel: '开始同步'
  }
}
