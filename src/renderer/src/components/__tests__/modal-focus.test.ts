import { describe, expect, it } from 'vitest'
import { wrappedFocusIndex } from '../modal-focus'

describe('wrappedFocusIndex', () => {
  it('moves forward and wraps at the end', () => {
    expect(wrappedFocusIndex(3, 0, false)).toBe(1)
    expect(wrappedFocusIndex(3, 2, false)).toBe(0)
  })

  it('moves backward and wraps at the start', () => {
    expect(wrappedFocusIndex(3, 2, true)).toBe(1)
    expect(wrappedFocusIndex(3, 0, true)).toBe(2)
  })

  it('recovers escaped focus and handles an empty panel', () => {
    expect(wrappedFocusIndex(3, -1, false)).toBe(0)
    expect(wrappedFocusIndex(3, -1, true)).toBe(2)
    expect(wrappedFocusIndex(0, -1, false)).toBe(-1)
  })
})
