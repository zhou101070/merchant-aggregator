import { nameNorm } from './name-norm'

/** Version / model tail: 7, 4o, 3.5, 4o1 — keep even when length 1 */
const VERSION_TAIL = /^\d+[a-z0-9.]*$/i

/**
 * Duration unit after a number (optional 个): 7天 / 1个月 / 24小时.
 * Kept glued so "grok 7天" is not misread as model version "7".
 */
const DURATION_UNIT = /^(个)?(小时|天|日|月|年|周|时)$/

/** Number + duration unit as one token (e.g. 7天, 1个月). */
const DURATION_TOKEN = /^\d+(个)?(小时|天|日|月|年|周|时)$/

/** True for pure version/model tails (e.g. 7, 4o, 3.5). */
export function isVersionTailToken(token: string): boolean {
  return VERSION_TAIL.test(token)
}

/**
 * Compact letter+version product code (k12, grok7, gpt4o).
 * Used to tighten SQL recall: whole-token title match, not category substring.
 */
export function isLetterVersionToken(token: string): boolean {
  return /^[a-z]+\d+[a-z0-9.]*$/i.test(token)
}

/** Strip spaces/hyphens so "k 12" / "k-12" → "k12". */
export function compactLetterVersion(token: string): string {
  return nameNorm(token).replace(/[\s-]/g, '')
}

/** Synonym group is (or expands from) a letter+version code like k12 / gpt4. */
export function isLetterVersionGroup(group: string[]): boolean {
  return group.some((v) => isLetterVersionToken(compactLetterVersion(v)))
}

/** True for duration tokens (e.g. 7天) — not model versions. */
export function isDurationToken(token: string): boolean {
  return DURATION_TOKEN.test(token)
}

/** Lone Latin letter left after split (not glued to version) — only noise we may drop. */
function isLatinLetterNoise(token: string): boolean {
  return /^[a-z]$/i.test(token)
}

/**
 * Significant characters that must survive tokenization (letters, digits, CJK).
 * Punctuation/space may be dropped; content must not.
 */
export function significantChars(s: string): string {
  return nameNorm(s).replace(/[^a-z0-9\u3400-\u9fff]+/gi, '')
}

/**
 * Split a free-text search query into match tokens.
 * - Normalizes (NFKC / case / spaces)
 * - Splits on punctuation & whitespace
 * - Splits Latin↔CJK and letter↔digit so "Claude月卡"/"grok7" → ["claude","月卡"] / ["grok","7"]
 * - Re-glues single Latin letter + version tail (k12→k12), so "k" is not dropped leaving only "12"
 * - Re-glues number + duration unit (7天 / 1个月) so duration stays one token
 * - Does NOT re-glue multi-letter + version: "grok … 7" stays multi-token (order AND, gap allowed)
 * - Must not drop content: every letter/digit/CJK from the input appears in some token
 *   (only lone Latin letters a–z may be dropped as noise)
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
    // Latin/digit ↔ CJK, then letter ↔ digit (grok7 → grok, 7)
    const sub = chunk.split(
      /(?<=[a-z0-9])(?=[\u3400-\u9fff])|(?<=[\u3400-\u9fff])(?=[a-z0-9])|(?<=[a-z])(?=[0-9])|(?<=[0-9])(?=[a-z])/i
    )
    for (const s of sub) {
      const t = s.trim()
      if (t) parts.push(t)
    }
  }

  // k12 / 12k / 7天: re-glue so content is not split into noise or bare version tails
  const rejoined: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const a = parts[i]!
    const b = parts[i + 1]
    if (b && /^[a-z]$/i.test(a) && VERSION_TAIL.test(b)) {
      rejoined.push(a + b)
      i++
      continue
    }
    if (b && VERSION_TAIL.test(a) && /^[a-z]$/i.test(b)) {
      rejoined.push(a + b)
      i++
      continue
    }
    if (b && VERSION_TAIL.test(a) && DURATION_UNIT.test(b)) {
      rejoined.push(a + b)
      i++
      continue
    }
    rejoined.push(a)
  }

  // Drop only lone Latin letters; keep digits, CJK (incl. len-1), and multi-char tokens
  const filtered = rejoined.filter((t) => !isLatinLetterNoise(t))
  const source = filtered.length ? filtered : rejoined.filter((t) => t.length >= 1)

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

/** Precompute title fields for shop_products at sync/write time. */
export function productTitleSearchFields(title: string): {
  titleNorm: string
  titleTokens: string
} {
  return {
    titleNorm: nameNorm(title),
    titleTokens: tokenizeQuery(title).join(' ')
  }
}

/** Escape `%`, `_`, `\` for SQLite LIKE ... ESCAPE '\\'. */
export function escapeLike(s: string): string {
  return s.replace(/([%_\\])/g, '\\$1')
}

/** Build a LIKE pattern for a token (`%token%` with metacharacters escaped). */
export function likeContains(token: string): string {
  return `%${escapeLike(token)}%`
}

/**
 * Whole-token LIKE for space-joined title_tokens.
 * Pair with SQL: `(' ' || COALESCE(title_tokens,'') || ' ') LIKE pattern`
 * so "7" matches "grok 7" but not "7878" / "17".
 */
export function likeTokenBoundary(token: string): string {
  return `% ${escapeLike(token)} %`
}
