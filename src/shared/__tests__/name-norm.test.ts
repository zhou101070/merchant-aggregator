import { describe, expect, it } from 'vitest'
import { nameNorm } from '../lib/name-norm'
import { parseLdxpItemKey, parseLdxpShopToken } from '../lib/url-parse'

describe('nameNorm', () => {
  it('trims, collapses spaces, lowercases', () => {
    expect(nameNorm('  Foo   店 ')).toBe('foo 店')
  })

  it('applies NFKC', () => {
    expect(nameNorm('ＡＢＣ')).toBe('abc')
  })
})

describe('ldxp url parse', () => {
  it('parses shop token from url and bare token', () => {
    expect(parseLdxpShopToken('https://pay.ldxp.cn/shop/Ab12Cd34')).toBe('Ab12Cd34')
    expect(parseLdxpShopToken('Ab12Cd34')).toBe('Ab12Cd34')
  })

  it('parses item key', () => {
    expect(parseLdxpItemKey('https://pay.ldxp.cn/item/Xy9Z')).toBe('Xy9Z')
    expect(parseLdxpItemKey('not-a-url')).toBeNull()
  })
})
