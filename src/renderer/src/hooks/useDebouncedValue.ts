import { useEffect, useState } from 'react'

/**
 * Debounce a value (e.g. committed search query after Enter).
 * Second return flushes immediately (deep link / apply saved / chip click).
 */
export function useDebouncedValue<T>(value: T, delayMs = 250): [T, (next: T) => void] {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])

  return [debounced, setDebounced]
}
