import { describe, expect, it } from 'vitest'
import {
  compactLetterVersion,
  escapeLike,
  isDurationToken,
  isLetterVersionGroup,
  isLetterVersionToken,
  isVersionTailToken,
  likeContains,
  likeTokenBoundary,
  productTitleSearchFields,
  significantChars,
  tokenizeQuery
} from '../lib/search-query'

/** Every letter/digit/CJK in input must appear in some token (order preserved as multiset cover). */
function assertTokensCoverInput(raw: string, allowDropLatinSingles = true): void {
  const tokens = tokenizeQuery(raw)
  const joined = tokens.join('')
  let rest = significantChars(raw)
  if (allowDropLatinSingles) {
    // lone a–z may be dropped as noise; strip those that never appear in tokens
    rest = rest.replace(/[a-z]/gi, (ch) => (joined.includes(ch.toLowerCase()) ? ch : ''))
  }
  for (const ch of rest) {
    expect(joined.includes(ch)).toBe(true)
  }
}

describe('tokenizeQuery', () => {
  it('splits on whitespace and punctuation', () => {
    expect(tokenizeQuery('Claude Pro / 月卡')).toEqual(['claude', 'pro', '月卡'])
  })

  it('splits Latin↔CJK boundaries without spaces', () => {
    expect(tokenizeQuery('Claude月卡')).toEqual(['claude', '月卡'])
    expect(tokenizeQuery('成品Outlook邮箱')).toEqual(['成品', 'outlook', '邮箱'])
  })

  it('dedupes and normalizes case/fullwidth', () => {
    expect(tokenizeQuery('  Ｃｌａｕｄｅ   Claude  ')).toEqual(['claude'])
  })

  it('drops only lone Latin letter noise; keeps content short tokens', () => {
    expect(tokenizeQuery('a b Claude')).toEqual(['claude'])
    expect(tokenizeQuery('AI')).toEqual(['ai'])
    // single CJK must not be dropped (would lose original content)
    expect(tokenizeQuery('卡')).toEqual(['卡'])
  })

  it('never loses letter/digit/CJK content from the original string', () => {
    for (const q of [
      'grok 7天',
      'grok7天',
      '质保1天',
      'Claude 1个月',
      '24小时',
      'grok 7',
      'k12',
      'Claude月卡',
      '成品Outlook邮箱',
      'a b Claude'
    ]) {
      assertTokensCoverInput(q)
    }
  })

  it('splits letter+version the same for spaced and glued forms', () => {
    expect(tokenizeQuery('grok 7')).toEqual(['grok', '7'])
    expect(tokenizeQuery('grok7')).toEqual(['grok', '7'])
    expect(tokenizeQuery('Grok-7')).toEqual(['grok', '7'])
    expect(tokenizeQuery('gpt4')).toEqual(['gpt', '4'])
    expect(tokenizeQuery('gpt 4')).toEqual(['gpt', '4'])
  })

  it('keeps single-letter + version glued (avoids k12 → only 12 matching 1112)', () => {
    expect(tokenizeQuery('k12')).toEqual(['k12'])
    expect(tokenizeQuery('K12')).toEqual(['k12'])
    expect(tokenizeQuery('k1')).toEqual(['k1'])
    expect(tokenizeQuery('12k')).toEqual(['12k'])
  })

  it('detects letter+version product codes', () => {
    expect(isLetterVersionToken('k12')).toBe(true)
    expect(isLetterVersionToken('gpt4o')).toBe(true)
    expect(isLetterVersionToken('12')).toBe(false)
    expect(isLetterVersionToken('claude')).toBe(false)
    expect(compactLetterVersion('k 12')).toBe('k12')
    expect(compactLetterVersion('k-12')).toBe('k12')
    expect(isLetterVersionGroup(['k12', 'k 12', 'k-12'])).toBe(true)
    expect(isLetterVersionGroup(['claude', '月卡'])).toBe(false)
  })

  it('keeps middle tokens so ordered multi-token queries stay AND', () => {
    expect(tokenizeQuery('grok xxxxxxxxxxxxxxxxxx 7')).toEqual([
      'grok',
      'xxxxxxxxxxxxxxxxxx',
      '7'
    ])
  })

  it('keeps number + duration unit as one token (not version 7)', () => {
    expect(tokenizeQuery('grok 7天')).toEqual(['grok', '7天'])
    expect(tokenizeQuery('grok7天')).toEqual(['grok', '7天'])
    expect(tokenizeQuery('质保1天')).toEqual(['质保', '1天'])
    expect(tokenizeQuery('Claude 1个月')).toEqual(['claude', '1个月'])
    expect(tokenizeQuery('24小时')).toEqual(['24小时'])
    // bare model version still splits
    expect(tokenizeQuery('grok 7')).toEqual(['grok', '7'])
  })
})

describe('productTitleSearchFields', () => {
  it('builds norm and space-joined tokens for sync storage', () => {
    expect(productTitleSearchFields('Claude月卡')).toEqual({
      titleNorm: 'claude月卡',
      titleTokens: 'claude 月卡'
    })
  })
})

describe('escapeLike / likeContains', () => {
  it('escapes LIKE metacharacters', () => {
    expect(escapeLike('100%_off\\x')).toBe('100\\%\\_off\\\\x')
    expect(likeContains('a_b')).toBe('%a\\_b%')
  })
})

describe('version tail helpers', () => {
  it('detects version tails', () => {
    expect(isVersionTailToken('7')).toBe(true)
    expect(isVersionTailToken('4o')).toBe(true)
    expect(isVersionTailToken('3.5')).toBe(true)
    expect(isVersionTailToken('grok')).toBe(false)
    expect(isVersionTailToken('k12')).toBe(false)
    expect(isVersionTailToken('7天')).toBe(false)
  })

  it('detects duration tokens', () => {
    expect(isDurationToken('7天')).toBe(true)
    expect(isDurationToken('1个月')).toBe(true)
    expect(isDurationToken('24小时')).toBe(true)
    expect(isDurationToken('7')).toBe(false)
    expect(isDurationToken('月卡')).toBe(false)
  })

  it('builds space-padded token boundary pattern', () => {
    expect(likeTokenBoundary('7')).toBe('% 7 %')
    expect(likeTokenBoundary('a_b')).toBe('% a\\_b %')
  })
})
