export type BlockTargetType = 'merchant' | 'shop_product'

export interface BlockedTarget {
  id: number
  targetType: BlockTargetType
  targetId: string
  titleSnapshot: string | null
  createdAt: string
}
