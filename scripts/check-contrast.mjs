#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- 纯 JS 设计工具脚本 */
// OKLCH → sRGB → WCAG contrast checker (Björn Ottosson's OKLab conversions)
function oklchToLinearSrgb(L, C, Hdeg) {
  const h = (Hdeg * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ ** 3,
    m = m_ ** 3,
    s = s_ ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ].map((v) => Math.min(1, Math.max(0, v)))
}
function gamma(u) {
  return u <= 0.0031308 ? 12.92 * u : 1.055 * u ** (1 / 2.4) - 0.055
}
function hex(L, C, H) {
  return (
    '#' +
    oklchToLinearSrgb(L, C, H)
      .map((u) =>
        Math.round(gamma(u) * 255)
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
  )
}
function lum(L, C, H) {
  const [r, g, b] = oklchToLinearSrgb(L, C, H)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(fg, bg) {
  const y1 = lum(...fg),
    y2 = lum(...bg)
  const [hi, lo] = y1 > y2 ? [y1, y2] : [y2, y1]
  return (hi + 0.05) / (lo + 0.05)
}
// [name, fg(L,C,H), bg(L,C,H), required]
const pairs = [
  // DARK theme --------------------------------------------------
  ['D ink / bg', [0.93, 0.007, 85], [0.165, 0.005, 80], 4.5],
  ['D ink / raised', [0.93, 0.007, 85], [0.19, 0.006, 80], 4.5],
  ['D ink2 / raised', [0.7, 0.01, 85], [0.19, 0.006, 80], 4.5],
  ['D ink3(placeholder) / raised', [0.64, 0.01, 85], [0.19, 0.006, 80], 4.5],
  ['D ink2 / bg', [0.7, 0.01, 85], [0.165, 0.005, 80], 4.5],
  ['D brass-text / bg', [0.8, 0.125, 84], [0.165, 0.005, 80], 4.5],
  ['D brass-text / raised', [0.8, 0.125, 84], [0.19, 0.006, 80], 4.5],
  ['D accent-ink / brass fill', [0.23, 0.04, 84], [0.8, 0.125, 84], 4.5],
  ['D ok / raised', [0.76, 0.14, 155], [0.19, 0.006, 80], 4.5],
  ['D danger / raised', [0.72, 0.16, 25], [0.19, 0.006, 80], 4.5],
  ['D warn / raised', [0.76, 0.13, 60], [0.19, 0.006, 80], 4.5],
  // LIGHT theme -------------------------------------------------
  ['L ink / bg', [0.22, 0.012, 85], [0.975, 0.003, 85], 4.5],
  ['L ink / raised(white)', [0.22, 0.012, 85], [0.995, 0.002, 85], 4.5],
  ['L ink2 / raised', [0.44, 0.014, 85], [0.995, 0.002, 85], 4.5],
  ['L ink3(placeholder) / raised', [0.5, 0.014, 85], [0.995, 0.002, 85], 4.5],
  ['L brass-text / raised', [0.47, 0.11, 78], [0.995, 0.002, 85], 4.5],
  ['L accent-ink / brass fill', [0.24, 0.03, 80], [0.68, 0.13, 80], 4.5],
  ['L ok / raised', [0.5, 0.13, 155], [0.995, 0.002, 85], 4.5],
  ['L danger / raised', [0.5, 0.18, 27], [0.995, 0.002, 85], 4.5],
  ['L warn / raised', [0.51, 0.12, 60], [0.995, 0.002, 85], 4.5],
  ['L accent-ink / brass fill(0.67)', [0.22, 0.03, 80], [0.67, 0.125, 80], 4.5],
  ['L accent-edge / bg', [0.52, 0.11, 78], [0.975, 0.003, 85], 3],
  ['L focus(0.55) / raised', [0.55, 0.12, 78], [0.995, 0.002, 85], 3],
  ['D ok-text / ok-wash', [0.76, 0.14, 155], [0.23, 0.03, 155], 4.5],
  // UI affordances (3:1 target) ---------------------------------
  ['D brass fill / bg', [0.8, 0.125, 84], [0.165, 0.005, 80], 3],
  ['D focus ring / raised', [0.8, 0.125, 84], [0.19, 0.006, 80], 3]
]
const ref = {
  'D bg-sunken': [0.135, 0.004, 80],
  'D bg': [0.165, 0.005, 80],
  'D raised': [0.19, 0.006, 80],
  'D overlay': [0.215, 0.007, 80],
  'D border': [0.28, 0.008, 85],
  'D border-strong': [0.36, 0.01, 85],
  'D ink': [0.93, 0.007, 85],
  'D ink2': [0.7, 0.01, 85],
  'D ink3': [0.64, 0.01, 85],
  'D accent': [0.8, 0.125, 84],
  'D accent-hover': [0.84, 0.125, 84],
  'D accent-ink': [0.23, 0.04, 84],
  'D ok': [0.76, 0.14, 155],
  'D danger': [0.72, 0.16, 25],
  'D warn': [0.76, 0.13, 60],
  'L bg-sunken': [0.955, 0.004, 85],
  'L bg': [0.975, 0.003, 85],
  'L raised': [0.995, 0.002, 85],
  'L border': [0.9, 0.006, 85],
  'L border-strong': [0.82, 0.008, 85],
  'L ink': [0.22, 0.012, 85],
  'L ink2': [0.44, 0.014, 85],
  'L ink3': [0.5, 0.014, 85],
  'L accent': [0.67, 0.125, 80],
  'L accent-hover': [0.63, 0.125, 80],
  'L accent-ink': [0.22, 0.03, 80],
  'L accent-text': [0.47, 0.11, 78],
  'L focus': [0.55, 0.12, 78],
  'L ok': [0.5, 0.13, 155],
  'L danger': [0.5, 0.18, 27],
  'L warn': [0.51, 0.12, 60]
}
let fail = 0
for (const [name, fg, bg, req] of pairs) {
  const r = contrast(fg, bg)
  const ok = r >= req
  if (!ok) fail++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${r.toFixed(2).padStart(6)} (need ${req})  ${name}  fg=${hex(...fg)} bg=${hex(...bg)}`
  )
}
console.log(fail ? `\n${fail} failures` : '\nall pass')
console.log('--- reference hex ---')
for (const [k, v] of Object.entries(ref)) console.log(k.padEnd(16), hex(...v))
