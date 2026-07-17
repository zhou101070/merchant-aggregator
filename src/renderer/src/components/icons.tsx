/**
 * 手绘内联图标集(DESIGN.md §7):16×16 · stroke 1.5 · round cap/join · currentColor。
 * 禁止混入其他风格图标；新增图标须遵守同一几何规范。
 */
const PATHS: Record<string, React.JSX.Element> = {
  search: (
    <>
      <circle cx="7" cy="7" r="4.4" />
      <path d="M10.3 10.3 13.5 13.5" />
    </>
  ),
  store: (
    <>
      <path d="M2 5.5 3.1 2.5h9.8L14 5.5" />
      <path d="M2.75 5.5v7.4a.6.6 0 0 0 .6.6h9.3a.6.6 0 0 0 .6-.6V5.5" />
      <path d="M6.25 13.5V9.4h3.5v4.1" />
    </>
  ),
  bookmark: <path d="M4.5 2.5h7a.4.4 0 0 1 .4.4v10.4L8 10.8l-3.9 2.5V2.9a.4.4 0 0 1 .4-.4Z" />,
  sync: (
    <>
      <path d="M13.5 6.5a5.6 5.6 0 0 0-10-2.1L2.5 6" />
      <path d="M2.5 2.75V6h3.25" />
      <path d="M2.5 9.5a5.6 5.6 0 0 0 10 2.1l1-1.6" />
      <path d="M13.5 13.25V10h-3.25" />
    </>
  ),
  sliders: (
    <>
      <path d="M2.5 4.25h6M11.5 4.25h2M2.5 8h1.5M7 8h6.5M2.5 11.75h6.5M12 11.75h1.5" />
      <circle cx="10" cy="4.25" r="1.5" />
      <circle cx="5.5" cy="8" r="1.5" />
      <circle cx="10.5" cy="11.75" r="1.5" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 4.9V8l2.1 1.3" />
    </>
  ),
  external: (
    <>
      <path d="M9.75 2.5h3.75v3.75" />
      <path d="M13.25 2.75 7.6 8.4" />
      <path d="M11.5 9.25v3a1.25 1.25 0 0 1-1.25 1.25h-6A1.25 1.25 0 0 1 3 12.25v-6A1.25 1.25 0 0 1 4.25 5h3" />
    </>
  ),
  refresh: (
    <>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.5-3.77" />
      <path d="M13.6 2.6v3.15h-3.15" />
    </>
  ),
  close: <path d="m4.25 4.25 7.5 7.5m0-7.5-7.5 7.5" />,
  check: <path d="m3.25 8.5 3.1 3.1L12.75 5" />,
  chevronDown: <path d="m4.25 6.25 3.75 3.75 3.75-3.75" />,
  chevronLeft: <path d="m9.75 4.25-3.75 3.75 3.75 3.75" />,
  chevronRight: <path d="m6.25 4.25 3.75 3.75-3.75 3.75" />,
  chevronFirst: (
    <>
      <path d="M4.5 4.25v7.5" />
      <path d="m11.5 4.25-3.75 3.75 3.75 3.75" />
    </>
  ),
  chevronLast: (
    <>
      <path d="M11.5 4.25v7.5" />
      <path d="m4.5 4.25 3.75 3.75-3.75 3.75" />
    </>
  ),
  download: (
    <>
      <path d="M8 2.5v7.75" />
      <path d="M4.9 7.4 8 10.5l3.1-3.1" />
      <path d="M2.75 13.5h10.5" />
    </>
  ),
  compare: (
    <>
      <path d="M11.25 2.9 13.5 5.15H4.75" />
      <path d="m4.75 13.1-2.25-2.25h8.75" />
    </>
  ),
  alert: (
    <>
      <path d="M8 2.9 14.3 13.3H1.7L8 2.9Z" />
      <path d="M8 7v2.6" />
      <path d="M8 11.5v.01" />
    </>
  )
}

export type IconName = keyof typeof PATHS

export function Icon({
  name,
  size = 16,
  className
}: {
  name: IconName
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {PATHS[name]}
    </svg>
  )
}
