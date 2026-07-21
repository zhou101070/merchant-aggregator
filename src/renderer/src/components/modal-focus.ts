export function wrappedFocusIndex(
  itemCount: number,
  currentIndex: number,
  reverse: boolean
): number {
  if (itemCount <= 0) return -1
  if (currentIndex < 0) return reverse ? itemCount - 1 : 0
  if (reverse) return currentIndex === 0 ? itemCount - 1 : currentIndex - 1
  return currentIndex === itemCount - 1 ? 0 : currentIndex + 1
}
