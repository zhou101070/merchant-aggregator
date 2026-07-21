import { describe, expect, it } from 'vitest'
import {
  defaultName,
  normalizeSavedSearches,
  pushSavedSearch,
  removeSavedSearch,
  renameSavedSearch
} from '../saved-searches'

const snap = {
  q: 'Claude Pro',
  titleContains: ['质保'],
  titleExcludes: ['共享'],
  inStockOnly: true,
  priceMin: 10,
  sort: 'price' as const,
  sortDir: 'asc' as const
}

describe('saved-searches', () => {
  it('defaultName joins q and chips', () => {
    expect(defaultName({ q: 'Claude', titleContains: ['Plus'] })).toBe('Claude · Plus')
    expect(defaultName({ q: '', titleContains: [] })).toBe('未命名搜索')
  })

  it('pushSavedSearch prepends and caps', () => {
    let list = pushSavedSearch([], snap, 'A')
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('A')
    expect(list[0].q).toBe('Claude Pro')
    for (let i = 0; i < 25; i++) {
      list = pushSavedSearch(list, { ...snap, q: `q${i}` }, `n${i}`)
    }
    expect(list.length).toBeLessThanOrEqual(20)
    expect(list[0].name).toBe('n24')
  })

  it('remove and rename', () => {
    const list = pushSavedSearch([], snap, 'A')
    const id = list[0].id
    expect(renameSavedSearch(list, id, 'B')[0].name).toBe('B')
    expect(removeSavedSearch(list, id)).toEqual([])
  })

  it('normalizeSavedSearches drops junk', () => {
    const out = normalizeSavedSearches([
      null,
      { id: 'x', name: 'ok', q: 'a', sort: 'score', sortDir: 'desc' },
      { name: 1 }
    ])
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('x')
    expect(out[0].q).toBe('a')
  })
})
