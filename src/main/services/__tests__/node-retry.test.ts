import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NODE_SCORE, PROXY_NODE_RETRY } from '@shared/constants'
import { AppError } from '@shared/types/errors'
import {
  isNodeRetryableError,
  legacyPickCandidateNodes,
  nodeRetryMaxCandidates,
  pickCandidateNodes
} from '../node-retry'
import { clearNodeScores } from '../node-score'

describe('isNodeRetryableError', () => {
  it('retries network-ish and WAF failures', () => {
    expect(isNodeRetryableError(new AppError('NETWORK', 'x'))).toBe(true)
    expect(isNodeRetryableError(new AppError('TIMEOUT', 'x'))).toBe(true)
    expect(isNodeRetryableError(new AppError('NEED_BROWSER', 'waf'))).toBe(true)
  })

  it('does not retry structural or cancelled failures', () => {
    expect(isNodeRetryableError(new AppError('CANCELLED', 'x'))).toBe(false)
    expect(isNodeRetryableError(new AppError('SCHEMA_VALIDATION', '指纹不符'))).toBe(false)
    expect(isNodeRetryableError(new AppError('PAUSED', 'x'))).toBe(false)
    expect(isNodeRetryableError(new AppError('NOT_FOUND', 'x'))).toBe(false)
    expect(isNodeRetryableError(new Error('plain'))).toBe(false)
    expect(isNodeRetryableError('string')).toBe(false)
  })
})

describe('nodeRetryMaxCandidates', () => {
  it('caps WAF retries at 1 node; network uses full budget', () => {
    expect(nodeRetryMaxCandidates(new AppError('NEED_BROWSER', 'waf'))).toBe(1)
    expect(nodeRetryMaxCandidates(new AppError('NETWORK', 'x'))).toBe(PROXY_NODE_RETRY.maxNodes)
    expect(nodeRetryMaxCandidates(new AppError('TIMEOUT', 'x'))).toBe(PROXY_NODE_RETRY.maxNodes)
  })
})

describe('legacyPickCandidateNodes', () => {
  const nodes = [
    { name: 'fast', delay: 80 },
    { name: 'mid', delay: 200 },
    { name: 'slow', delay: 900 },
    { name: 'unknown' }
  ]

  it('takes up to max, skipping platform-bad nodes', () => {
    expect(legacyPickCandidateNodes(nodes, new Set(['mid']), 2)).toEqual(['fast', 'slow'])
  })

  it('preserves delay order and caps at max', () => {
    expect(legacyPickCandidateNodes(nodes, new Set(), 3)).toEqual(['fast', 'mid', 'slow'])
  })

  it('returns empty when all nodes bad or list empty', () => {
    expect(
      legacyPickCandidateNodes(nodes, new Set(['fast', 'mid', 'slow', 'unknown']), 3)
    ).toEqual([])
    expect(legacyPickCandidateNodes([], new Set(), 3)).toEqual([])
  })

  it('ignores blank names', () => {
    expect(legacyPickCandidateNodes([{ name: '  ' }, { name: 'a' }], new Set(), 3)).toEqual([
      'a'
    ])
  })
})

describe('pickCandidateNodes', () => {
  beforeEach(() => {
    clearNodeScores()
    ;(NODE_SCORE as { enabled: boolean }).enabled = true
  })

  afterEach(() => {
    clearNodeScores()
    ;(NODE_SCORE as { enabled: boolean }).enabled = true
  })

  it('uses legacy delay order when scoring disabled', () => {
    ;(NODE_SCORE as { enabled: boolean }).enabled = false
    const nodes = [
      { name: 'fast', delay: 80 },
      { name: 'mid', delay: 200 },
      { name: 'slow', delay: 900 }
    ]
    expect(pickCandidateNodes(nodes, new Set(['mid']), 2)).toEqual(['fast', 'slow'])
  })

  it('prefers lower cold-start delay under fixed rng when enabled', () => {
    const nodes = [
      { name: 'slow', delay: 900 },
      { name: 'fast', delay: 50 },
      { name: 'mid', delay: 200 }
    ]
    // rng=0 drains in list order; sort by weight puts fast first
    const picked = pickCandidateNodes(nodes, new Set(), 3, () => 0)
    expect(picked[0]).toBe('fast')
    expect(picked).toHaveLength(3)
  })
})
