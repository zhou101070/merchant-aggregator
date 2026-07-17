import { describe, expect, it } from 'vitest'
import {
  adjacentPairBonus,
  compareRelevance,
  computeIdfFromRows,
  expandTokenGroups,
  idfWeight,
  inQueryOrder,
  scoreShopRank,
  synonymGroup
} from '../search-rank'
import { tokenizeQuery } from '../search-query'

function ctx(q: string, idfEntries: Array<[string, number]> = []): Parameters<typeof scoreShopRank>[1] {
  const tokens = tokenizeQuery(q)
  const tokenGroups = expandTokenGroups(tokens)
  const idf = new Map(idfEntries)
  for (const t of tokens) {
    const n = t
    if (!idf.has(n)) idf.set(n, 1.5)
  }
  return { q, tokens, tokenGroups, idf, nowMs: Date.parse('2026-07-17T12:00:00Z') }
}

describe('search-rank', () => {
  it('expands product synonyms', () => {
    expect(synonymGroup('gpt4')).toEqual(expect.arrayContaining(['gpt4', 'chatgpt', 'gpt-4']))
    expect(synonymGroup('月卡')).toEqual(expect.arrayContaining(['月卡', 'monthly']))
    // bare '+' must not alias plus (would match any title containing +)
    expect(synonymGroup('plus')).toEqual(['plus'])
    expect(synonymGroup('plus')).not.toContain('+')
  })

  it('prefers full title coverage over shop-name only hits', () => {
    const c = ctx('Claude 月卡', [
      ['claude', 1.2],
      ['月卡', 2.0]
    ])
    const titleHit = scoreShopRank(
      {
        title: 'Claude Pro 月卡',
        shopName: '好店',
        stock: 5,
        merchantHealth: 'healthy',
        fetchedAt: '2026-07-17T10:00:00Z'
      },
      c
    )
    const shopOnly = scoreShopRank(
      {
        title: '无关商品',
        shopName: 'Claude 专营',
        stock: 5,
        merchantHealth: 'healthy',
        fetchedAt: '2026-07-17T10:00:00Z'
      },
      c
    )
    expect(titleHit).toBeGreaterThan(shopOnly + 20)
  })

  it('rewards query order and adjacency in title', () => {
    const groups = expandTokenGroups(['claude', '月卡'])
    expect(inQueryOrder('claude pro 月卡', groups)).toBe(true)
    expect(inQueryOrder('月卡 claude pro', groups)).toBe(false)
    expect(adjacentPairBonus('claude 月卡 质保', groups)).toBeGreaterThan(
      adjacentPairBonus('claude 超级加长无关描述然后才是 月卡', groups)
    )
  })

  it('idfWeight grows when document frequency is low', () => {
    expect(idfWeight(1000, 2)).toBeGreaterThan(idfWeight(1000, 200))
  })

  it('computeIdfFromRows weights rare tokens higher within candidates', () => {
    const tokens = ['claude', '月卡']
    const groups = expandTokenGroups(tokens)
    // claude in 1/4 rows, 月卡 in 3/4 → claude rarer → higher idf
    const idf = computeIdfFromRows(
      [
        { title: 'Claude Pro 月卡' },
        { title: 'GPT 月卡' },
        { title: '邮箱 月卡' },
        { title: '无关商品' }
      ],
      tokens,
      groups
    )
    expect(idf.get('claude')!).toBeGreaterThan(idf.get('月卡')!)
  })

  it('compareRelevance uses stock then price then id', () => {
    const a = {
      id: 'a',
      score: 10,
      stockCount: 0,
      price: 1,
      merchantHealth: 'healthy',
      fetchedAt: '2026-07-01'
    }
    const b = {
      id: 'b',
      score: 10,
      stockCount: 3,
      price: 50,
      merchantHealth: 'healthy',
      fetchedAt: '2026-07-01'
    }
    expect(compareRelevance(a, b)).toBeGreaterThan(0) // b better (in stock)
    const c = { ...b, id: 'c', price: 10 }
    expect(compareRelevance(b, c)).toBeGreaterThan(0) // c cheaper
  })
})
