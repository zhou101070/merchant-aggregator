import { describe, expect, it } from 'vitest'
import { pushRecentSearch } from '../recent-searches'

describe('pushRecentSearch', () => {
  it('prepends and dedupes case-insensitively', () => {
    expect(pushRecentSearch(['Claude', 'GPT'], 'claude')).toEqual(['claude', 'GPT'])
    expect(pushRecentSearch(['a', 'b'], 'c')).toEqual(['c', 'a', 'b'])
  })

  it('ignores empty', () => {
    expect(pushRecentSearch(['a'], '  ')).toEqual(['a'])
  })
})
