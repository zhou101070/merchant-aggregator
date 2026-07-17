import { nameNorm } from './name-norm'

/**
 * Split a free-text search query into match tokens.
 * - Normalizes (NFKC / case / spaces)
 * - Splits on punctuation & whitespace
 * - Splits Latin↔CJK boundaries so "Claude月卡" → ["claude", "月卡"]
 * - Drops very short pure-punctuation noise; keeps length ≥ 2 (or the sole remnant)
 */
export function tokenizeQuery(raw: string): string[] {
  const norm = nameNorm(raw)
  if (!norm) return []

  const rough = norm
    .split(/[\s\-_/:|·,，.。+＋=＝~～*＊#＃@＠!！?？;；'’"“”`（）()【】[\]「」<>《》]+/)
    .map((t) => t.trim())
    .filter(Boolean)

  const parts: string[] = []
  for (const chunk of rough) {
    // Split at Latin/digit ↔ CJK boundaries (keeps runs intact)
    const sub = chunk.split(/(?<=[a-z0-9])(?=[\u3400-\u9fff])|(?<=[\u3400-\u9fff])(?=[a-z0-9])/i)
    for (const s of sub) {
      const t = s.trim()
      if (t) parts.push(t)
    }
  }

  const filtered = parts.filter((t) => t.length >= 2)
  const source = filtered.length ? filtered : parts.filter((t) => t.length >= 1)

  // Dedupe while preserving order
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of source) {
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/** Escape `%`, `_`, `\` for SQLite LIKE ... ESCAPE '\\'. */
export function escapeLike(s: string): string {
  return s.replace(/([%_\\])/g, '\\$1')
}

/** Build a LIKE pattern for a token (`%token%` with metacharacters escaped). */
export function likeContains(token: string): string {
  return `%${escapeLike(token)}%`
}
