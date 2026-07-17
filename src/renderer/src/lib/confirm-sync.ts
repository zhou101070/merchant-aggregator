/**
 * 同步类长任务的确认文案(供 useConfirm 使用，见 DESIGN.md §8.2)。
 */
import type { ConfirmSpec } from '../components/use-confirm'

/** 一键初始化：商家 + Top-N 店铺。 */
export function bootstrapSpec(): ConfirmSpec {
  return {
    title: '一键初始化',
    body:
      '同步 PriceAI 商家列表，并抓取报价数 Top 50 的可深刮店铺商品。\n' +
      '将访问 priceai.cc 与已注册发卡网，可能需要十几分钟，可随时取消。',
    confirmLabel: '开始同步'
  }
}

/** 全量 / 增量店铺深刮（可刮 = shop_platform + shop_token 且 profile.enabled）。 */
export function shopAllSpec(count: number, opts?: { force?: boolean }): ConfirmSpec {
  const n = Math.max(0, count)
  return {
    title: opts?.force ? '强制全量同步店铺' : '增量同步店铺',
    body:
      (opts?.force
        ? `将强制重刮全部约 ${n} 家可深刮店铺（忽略新鲜期）。`
        : `将同步可深刮店铺商品（最多 ${n} 家，自动跳过新鲜期内已同步的店）。`) +
      '\n串行访问已启用发卡网，可能需要较长时间，可随时取消。',
    confirmLabel: '开始同步'
  }
}

/** @deprecated use shopAllSpec */
export const ldxpAllSpec = shopAllSpec
