import { AppError } from '@shared/types/errors'
import { NODE_SCORE, PROXY_NODE_RETRY } from '@shared/constants'
import { pickWeightedNodes } from './node-score'

/**
 * Errors where switching proxy node is worth a retry: network-ish failures and
 * WAF blocks (exit IP dependent). Structural failures (wrong fingerprint,
 * schema, paused, cancelled) are not node-related.
 */
export function isNodeRetryableError(err: unknown): boolean {
  if (!(err instanceof AppError)) return false
  return err.code === 'NETWORK' || err.code === 'TIMEOUT' || err.code === 'NEED_BROWSER'
}

/**
 * How many alternate nodes to pin after the first failure.
 * NEED_BROWSER (WAF) is exit-IP sensitive but each try opens a full shop tab —
 * cap at 1 so we don't burn 3× tabs before the queue-level WAF defer pass.
 */
export function nodeRetryMaxCandidates(err: unknown): number {
  if (err instanceof AppError && err.code === 'NEED_BROWSER') return 1
  return PROXY_NODE_RETRY.maxNodes
}

/** Legacy: delay-ascending list, take first max non-bad names. */
export function legacyPickCandidateNodes(
  nodes: Array<{ name: string; delay?: number }>,
  badNames: ReadonlySet<string>,
  max: number
): string[] {
  const out: string[] = []
  for (const n of nodes) {
    if (out.length >= max) break
    const name = n.name.trim()
    if (!name || badNames.has(name)) continue
    out.push(name)
  }
  return out
}

/**
 * Pick up to `max` candidate nodes, skipping platform-bad ones.
 * When NODE_SCORE.enabled: weighted sample then weight-desc order.
 * When disabled: delay order (listNodes pre-sorts ascending).
 */
export function pickCandidateNodes(
  nodes: Array<{ name: string; delay?: number }>,
  badNames: ReadonlySet<string>,
  max: number,
  rng?: () => number
): string[] {
  if (!NODE_SCORE.enabled) {
    return legacyPickCandidateNodes(nodes, badNames, max)
  }
  return pickWeightedNodes(nodes, badNames, max, rng ?? Math.random)
}
