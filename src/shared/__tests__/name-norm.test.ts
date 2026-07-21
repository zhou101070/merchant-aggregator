import { describe, expect, it } from 'vitest'
import { nameNorm } from '../lib/name-norm'

describe('nameNorm', () => {
  it('trims, collapses spaces, lowercases', () => {
    expect(nameNorm('  Foo   店 ')).toBe('foo 店')
  })

  it('applies NFKC', () => {
    expect(nameNorm('ＡＢＣ')).toBe('abc')
  })
})
