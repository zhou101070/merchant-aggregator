/** Normalize merchant/store names for join (collision-safe equality only). */
export function nameNorm(s: string): string {
  return s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('zh-CN')
}
