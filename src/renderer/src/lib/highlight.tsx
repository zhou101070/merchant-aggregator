import type { ReactNode } from 'react'
import { tokenizeQuery } from '@shared/lib/search-query'

/** Case-insensitive highlight of query tokens in display text. */
export function highlightText(text: string, query: string): ReactNode {
  const q = query.trim()
  if (!q || !text) return text

  // Longest-first so "Claude Pro" highlights beat bare "Pro"
  const tokens = tokenizeQuery(q).sort((a, b) => b.length - a.length)
  if (!tokens.length) return text

  const pattern = tokens.map(escapeRegExp).join('|')
  if (!pattern) return text
  const re = new RegExp(`(${pattern})`, 'gi')
  const parts = text.split(re)
  return parts.map((part, i) => {
    const isHit = tokens.some((t) => part.toLowerCase() === t.toLowerCase())
    return isHit ? (
      <mark key={`${i}-${part}`} className="hl">
        {part}
      </mark>
    ) : (
      <span key={`${i}-${part}`}>{part}</span>
    )
  })
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
