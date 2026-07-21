/**
 * Client-side shop product match/rank — same tokenize + synonym + score as homepage search.
 */
import { nameNorm } from './name-norm'
import { tokenizeQuery } from './search-query'
import {
  compareRelevance,
  computeIdfFromRows,
  expandTokenGroups,
  groupMatchesRecall,
  scoreShopRank,
  type RankContext,
  type RankRow
} from './search-rank'
import type { ShopProduct } from '../types/product'

function productFields(p: ShopProduct): { titleN: string; catN: string; typeN: string; shopN: string } {
  return {
    titleN: nameNorm(p.title),
    catN: nameNorm(p.categoryName ?? ''),
    typeN: nameNorm(p.goodsType ?? ''),
    shopN: nameNorm(p.shopName ?? '')
  }
}

function toRankRow(p: ShopProduct): RankRow {
  return {
    title: p.title,
    shopName: p.shopName,
    categoryName: p.categoryName,
    goodsType: p.goodsType,
    stock: p.stock,
    fetchedAt: p.fetchedAt,
    price: p.price
  }
}

/** Token-AND + synonym-OR (mirrors homepage SQL recall without soft-OR fallback). */
export function shopProductMatchesQuery(p: ShopProduct, rawQ: string): boolean {
  const q = rawQ.trim()
  if (!q) return true

  const tokens = tokenizeQuery(q)
  const groups = expandTokenGroups(tokens)
  const { titleN, catN, typeN, shopN } = productFields(p)

  if (!groups.length) {
    const nq = nameNorm(q)
    return (
      titleN.includes(nq) || catN.includes(nq) || typeN.includes(nq) || shopN.includes(nq)
    )
  }

  return groups.every((g) => groupMatchesRecall({ titleN, catN, typeN, shopN }, g))
}

/** Filter then rank with homepage scoreShopRank / compareRelevance. */
export function filterAndRankShopProducts(products: ShopProduct[], rawQ: string): ShopProduct[] {
  const q = rawQ.trim()
  if (!q) return products

  const matched = products.filter((p) => shopProductMatchesQuery(p, q))
  if (matched.length <= 1) return matched

  const tokens = tokenizeQuery(q)
  const tokenGroups = expandTokenGroups(tokens)
  if (!tokenGroups.length) {
    const nq = nameNorm(q)
    return [...matched].sort((a, b) => {
      const at = nameNorm(a.title).includes(nq) ? 0 : 1
      const bt = nameNorm(b.title).includes(nq) ? 0 : 1
      if (at !== bt) return at - bt
      return a.id.localeCompare(b.id)
    })
  }

  const rankRows = matched.map(toRankRow)
  const idf = computeIdfFromRows(rankRows, tokens, tokenGroups)
  const ctx: RankContext = { q, tokens, tokenGroups, idf }
  const scored = matched.map((p) => ({
    p,
    score: scoreShopRank(toRankRow(p), ctx),
    stockCount: p.stock,
    price: p.price,
    fetchedAt: p.fetchedAt,
    id: p.id
  }))
  scored.sort((a, b) => compareRelevance(a, b))
  return scored.map((x) => x.p)
}
