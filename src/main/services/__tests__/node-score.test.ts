import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NODE_SCORE } from '@shared/constants'
import {
  clearNodeScores,
  getNodeScore,
  listNodeScores,
  pickWeightedNodes,
  pruneNodeScores,
  purgeIdleNodeScores,
  recordAttemptFailure,
  recordAttemptSuccess,
  recordWafHit,
  weightedSampleWithoutReplacement
} from '../node-score'

describe('node-score', () => {
  beforeEach(() => {
    clearNodeScores()
    ;(NODE_SCORE as { enabled: boolean }).enabled = true
  })

  afterEach(() => {
    clearNodeScores()
    ;(NODE_SCORE as { enabled: boolean }).enabled = true
  })

  describe('recordAttemptSuccess', () => {
    it('seeds ewma from delay cold start', () => {
      recordAttemptSuccess('n1', { delay: 120 })
      const s = getNodeScore('n1')!
      expect(s.ewmaMs).toBe(120)
      expect(s.samples).toBe(1)
      expect(s.failStreak).toBe(0)
    })

    it('heals ewma toward cold after failure', () => {
      recordAttemptFailure('n1')
      const afterFail = getNodeScore('n1')!.ewmaMs!
      expect(afterFail).toBe(NODE_SCORE.failPenaltyBaseMs)
      recordAttemptSuccess('n1', { delay: 100 })
      const afterHeal = getNodeScore('n1')!.ewmaMs!
      expect(afterHeal).toBeLessThan(afterFail)
      expect(afterHeal).toBeCloseTo(
        NODE_SCORE.alphaHeal * 100 + (1 - NODE_SCORE.alphaHeal) * afterFail,
        5
      )
      expect(getNodeScore('n1')!.failStreak).toBe(0)
    })
  })

  describe('recordAttemptFailure', () => {
    it('null first failure uses base 3s not base×mult', () => {
      recordAttemptFailure('n1')
      expect(getNodeScore('n1')!.ewmaMs).toBe(NODE_SCORE.failPenaltyBaseMs)
      expect(getNodeScore('n1')!.failStreak).toBe(1)
    })

    it('failure from 200ms lands ~1040', () => {
      recordAttemptSuccess('n1', { delay: 200 })
      recordAttemptFailure('n1')
      expect(getNodeScore('n1')!.ewmaMs).toBeCloseTo(1040, 5)
    })
  })

  describe('recordWafHit', () => {
    it('does not change ewma or failStreak', () => {
      recordAttemptSuccess('n1', { delay: 100 })
      recordWafHit('n1')
      const s = getNodeScore('n1')!
      expect(s.ewmaMs).toBe(100)
      expect(s.failStreak).toBe(0)
      expect(s.wafHits).toBe(1)
    })
  })

  describe('enabled=false', () => {
    it('record* are no-ops', () => {
      ;(NODE_SCORE as { enabled: boolean }).enabled = false
      recordAttemptSuccess('n1', { delay: 50 })
      recordAttemptFailure('n1')
      recordWafHit('n1')
      expect(listNodeScores()).toEqual([])
    })
  })

  describe('pickWeightedNodes', () => {
    it('skips bad names and blank', () => {
      const names = pickWeightedNodes(
        [{ name: '  ' }, { name: 'a', delay: 50 }, { name: 'b', delay: 80 }],
        new Set(['b']),
        3,
        () => 0
      )
      expect(names).toEqual(['a'])
    })

    it('returns weight-desc after fixed rng sample', () => {
      recordAttemptSuccess('fast', { delay: 50 })
      recordAttemptFailure('slow')
      // rng=0 always takes remaining[0] in pool order; then sort by weight
      const names = pickWeightedNodes(
        [
          { name: 'slow', delay: 900 },
          { name: 'fast', delay: 50 }
        ],
        new Set(),
        2,
        () => 0
      )
      expect(names[0]).toBe('fast')
      expect(names).toContain('slow')
    })

    it('empty / max0 / all bad', () => {
      expect(pickWeightedNodes([], new Set(), 3)).toEqual([])
      expect(pickWeightedNodes([{ name: 'a' }], new Set(), 0)).toEqual([])
      expect(pickWeightedNodes([{ name: 'a' }], new Set(['a']), 3)).toEqual([])
    })
  })

  describe('weightedSampleWithoutReplacement', () => {
    it('is reproducible with fixed rng', () => {
      const pool = [
        { name: 'a', weight: 1 },
        { name: 'b', weight: 1 },
        { name: 'c', weight: 1 }
      ]
      const a = weightedSampleWithoutReplacement(pool, 2, () => 0).map((n) => n.name)
      const b = weightedSampleWithoutReplacement(pool, 2, () => 0).map((n) => n.name)
      expect(a).toEqual(b)
      expect(a).toEqual(['a', 'b'])
    })
  })

  describe('pruneNodeScores', () => {
    it('removes unknown names', () => {
      recordAttemptSuccess('keep', { delay: 100 })
      recordAttemptSuccess('drop', { delay: 100 })
      pruneNodeScores(new Set(['keep']))
      expect(getNodeScore('keep')).not.toBeNull()
      expect(getNodeScore('drop')).toBeNull()
    })
  })

  describe('more formulas / edges', () => {
    it('failure from 5000ms lands ~8000', () => {
      recordAttemptSuccess('n1', { delay: 5000 })
      recordAttemptFailure('n1')
      expect(getNodeScore('n1')!.ewmaMs).toBeCloseTo(8000, 5)
    })

    it('dedupes trimmed names in pick', () => {
      const names = pickWeightedNodes(
        [
          { name: 'a', delay: 50 },
          { name: ' a ', delay: 50 }
        ],
        new Set(),
        2,
        () => 0
      )
      expect(names).toEqual(['a'])
    })

    it('purgeIdleNodeScores drops stale entries', () => {
      recordAttemptSuccess('old', { delay: 100 })
      const lastAt = Date.parse(getNodeScore('old')!.lastAt!)
      purgeIdleNodeScores(lastAt + NODE_SCORE.idleClearMs + 1)
      expect(getNodeScore('old')).toBeNull()
    })

    it('recordWafHit does not change lastAt', () => {
      recordAttemptSuccess('n1', { delay: 100 })
      const before = getNodeScore('n1')!.lastAt
      recordWafHit('n1')
      expect(getNodeScore('n1')!.lastAt).toBe(before)
      expect(getNodeScore('n1')!.wafHits).toBe(1)
    })

    it('equal-weight stable order keeps sample order', () => {
      const pool = [
        { name: 'a', weight: 1 },
        { name: 'b', weight: 1 },
        { name: 'c', weight: 1 }
      ]
      // pick all three with rng=0 → [a,b,c]; sort equal weight keeps that order
      const picked = weightedSampleWithoutReplacement(pool, 3, () => 0)
      const indexed = picked.map((n, i) => ({ n, i }))
      indexed.sort((a, b) => {
        if (b.n.weight !== a.n.weight) return b.n.weight - a.n.weight
        return a.i - b.i
      })
      expect(indexed.map((x) => x.n.name)).toEqual(['a', 'b', 'c'])
    })
  })
})
