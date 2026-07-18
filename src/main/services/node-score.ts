import { NODE_SCORE } from '@shared/constants'

export interface NodeScoreState {
  nodeName: string
  ewmaMs: number | null
  samples: number
  lastAt: string | null
  failStreak: number
  wafHits: number
}

interface WeightedNode {
  name: string
  delay?: number
  weight: number
}

const states = new Map<string, NodeScoreState>()

function nowIso(): string {
  return new Date().toISOString()
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x))
}

function isFinitePositive(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0
}

function ensureState(nodeName: string): NodeScoreState {
  const name = nodeName.trim()
  let s = states.get(name)
  if (!s) {
    s = {
      nodeName: name,
      ewmaMs: null,
      samples: 0,
      lastAt: null,
      failStreak: 0,
      wafHits: 0
    }
    states.set(name, s)
  }
  return s
}

/** Lazy idle clear on pick / record / list entry points. */
export function purgeIdleNodeScores(nowMs: number = Date.now()): void {
  const limit = NODE_SCORE.idleClearMs
  for (const [key, s] of states) {
    if (!s.lastAt) continue
    const t = Date.parse(s.lastAt)
    if (!Number.isFinite(t)) continue
    if (nowMs - t > limit) states.delete(key)
  }
}

function medianEwma(): number | null {
  const vals: number[] = []
  for (const s of states.values()) {
    if (s.ewmaMs != null && Number.isFinite(s.ewmaMs)) vals.push(s.ewmaMs)
  }
  if (!vals.length) return null
  vals.sort((a, b) => a - b)
  const mid = Math.floor(vals.length / 2)
  if (vals.length % 2 === 0) {
    return (vals[mid - 1]! + vals[mid]!) / 2
  }
  return vals[mid]!
}

export function coldStartLatency(delay?: number): number {
  if (isFinitePositive(delay)) return delay
  const med = medianEwma()
  if (med != null) return med
  return NODE_SCORE.neutralMs
}

export function recordAttemptSuccess(
  nodeName: string,
  coldHint?: { delay?: number }
): void {
  if (!NODE_SCORE.enabled) return
  const name = nodeName.trim()
  if (!name) return
  purgeIdleNodeScores()
  const s = ensureState(name)
  const cold = coldStartLatency(coldHint?.delay)
  s.failStreak = 0
  s.lastAt = nowIso()
  s.samples += 1
  if (s.ewmaMs == null) {
    s.ewmaMs = cold
  } else {
    s.ewmaMs = NODE_SCORE.alphaHeal * cold + (1 - NODE_SCORE.alphaHeal) * s.ewmaMs
  }
}

export function recordAttemptFailure(nodeName: string): void {
  if (!NODE_SCORE.enabled) return
  const name = nodeName.trim()
  if (!name) return
  purgeIdleNodeScores()
  const s = ensureState(name)
  let penaltyMs: number
  if (s.ewmaMs == null) {
    penaltyMs = NODE_SCORE.failPenaltyBaseMs
    s.ewmaMs = penaltyMs
  } else {
    const raw = s.ewmaMs * NODE_SCORE.failPenaltyMultiplier
    penaltyMs = clamp(raw, NODE_SCORE.failPenaltyBaseMs, NODE_SCORE.failPenaltyMaxMs)
    s.ewmaMs = NODE_SCORE.alpha * penaltyMs + (1 - NODE_SCORE.alpha) * s.ewmaMs
  }
  s.samples += 1
  s.failStreak += 1
  s.lastAt = nowIso()
}

export function recordWafHit(nodeName: string): void {
  if (!NODE_SCORE.enabled) return
  const name = nodeName.trim()
  if (!name) return
  purgeIdleNodeScores()
  const s = ensureState(name)
  s.wafHits += 1
  // 不更新 lastAt：避免纯 WAF 活动推迟 idle 清空（ewma/failStreak 不变）
}

function nodeWeight(
  ewmaMs: number | null,
  samples: number,
  failStreak: number,
  delay?: number
): number {
  const latency = ewmaMs ?? coldStartLatency(delay)
  const base = 1 / (latency + NODE_SCORE.floorMs)
  const streak = Math.min(failStreak, NODE_SCORE.failStreakSoftCap)
  const failFactor = Math.max(
    NODE_SCORE.failWeightMin,
    1 - streak * NODE_SCORE.failWeightStep
  )
  const temp =
    samples >= NODE_SCORE.minSamplesPreferEwma
      ? NODE_SCORE.temperature
      : Math.min(1.0, NODE_SCORE.temperature)
  return Math.pow(base * failFactor, temp)
}

/** Sequential roulette without replacement; rng ∈ [0, 1). */
export function weightedSampleWithoutReplacement(
  pool: WeightedNode[],
  max: number,
  rng: () => number = Math.random
): WeightedNode[] {
  if (max <= 0 || !pool.length) return []
  const remaining = pool.filter((n) => n.weight > 0).map((n) => ({ ...n }))
  const picked: WeightedNode[] = []
  while (picked.length < max && remaining.length) {
    let total = 0
    for (const n of remaining) total += n.weight
    if (!(total > 0)) break
    let r = rng() * total
    if (!Number.isFinite(r) || r < 0) r = 0
    let acc = 0
    let idx = remaining.length - 1
    for (let i = 0; i < remaining.length; i++) {
      acc += remaining[i]!.weight
      if (r < acc || i === remaining.length - 1) {
        idx = i
        break
      }
    }
    const [chosen] = remaining.splice(idx, 1)
    if (chosen) picked.push(chosen)
  }
  return picked
}

export function pickWeightedNodes(
  nodes: Array<{ name: string; delay?: number }>,
  badNames: ReadonlySet<string>,
  max: number,
  rng: () => number = Math.random
): string[] {
  purgeIdleNodeScores()
  if (max <= 0) return []

  const pool: WeightedNode[] = []
  const seen = new Set<string>()
  for (const n of nodes) {
    const name = n.name.trim()
    if (!name || badNames.has(name) || seen.has(name)) continue
    seen.add(name)
    const s = states.get(name)
    const weight = nodeWeight(
      s?.ewmaMs ?? null,
      s?.samples ?? 0,
      s?.failStreak ?? 0,
      n.delay
    )
    if (!(weight > 0)) continue
    pool.push({ name, delay: n.delay, weight })
  }

  const sampled = weightedSampleWithoutReplacement(pool, max, rng)
  // Stable sort by weight desc; equal weight keeps sampled order
  const indexed = sampled.map((n, i) => ({ n, i }))
  indexed.sort((a, b) => {
    if (b.n.weight !== a.n.weight) return b.n.weight - a.n.weight
    return a.i - b.i
  })
  return indexed.map((x) => x.n.name)
}

export function pruneNodeScores(knownNames: ReadonlySet<string>): void {
  const known = new Set([...knownNames].map((n) => n.trim()).filter(Boolean))
  for (const key of states.keys()) {
    if (!known.has(key)) states.delete(key)
  }
}

export function listNodeScores(): NodeScoreState[] {
  purgeIdleNodeScores()
  return [...states.values()].map((s) => ({ ...s }))
}

export function clearNodeScores(): void {
  states.clear()
}

export function getNodeScore(nodeName: string): NodeScoreState | null {
  purgeIdleNodeScores()
  const s = states.get(nodeName.trim())
  return s ? { ...s } : null
}
