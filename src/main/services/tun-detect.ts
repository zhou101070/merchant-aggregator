import os from 'node:os'

/** Product / driver names commonly used by TUN-mode proxies (Win + mac + Linux). */
const NAME_RE =
  /(?:^|[-_\s.])(meta|mihomo|clash|wintun|sing-?box|sftun|hysteria|nekoray|v2raytun|cfw-?tun)(?:$|[-_\s.])/i

/** Linux-style TUN device names (not "tunnel", not VMware). */
const LINUX_TUN_RE = /^tun\d+$/i

/** Clash / mihomo fake-ip / reserved benchmark ranges often bound on TUN. */
function isLikelyTunIpv4(address: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  // 198.18.0.0/15 — commonly used by Clash fake-ip / TUN
  return a === 198 && (b === 18 || b === 19)
}

function isIpv4Family(family: string | number): boolean {
  return family === 'IPv4' || family === 4
}

/** Pure name heuristic (unit-testable). */
export function isLikelyTunInterfaceName(name: string): boolean {
  const n = name.trim()
  if (!n) return false
  if (NAME_RE.test(n)) return true
  if (LINUX_TUN_RE.test(n)) return true
  return false
}

export type TunDetectResult = {
  likely: boolean
  /** Matched interface names (for UI hint, no secrets). */
  names: string[]
}

/**
 * Heuristic: active NICs that look like a user-space TUN proxy (Clash/Meta/mihomo/…).
 * Not 100% accurate — used only for soft warnings.
 *
 * - Win/mac/Linux: interface name keywords (Meta, mihomo, Clash, Wintun, …)
 * - Linux: tun0 / tun1 …
 * - mac: bare utun* is ignored (system often creates them); utun + 198.18/19 IPv4 counts
 */
export function detectLikelyTunProxy(
  ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()
): TunDetectResult {
  const hit = new Set<string>()

  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs?.length) continue

    if (isLikelyTunInterfaceName(name)) {
      hit.add(name)
      continue
    }

    // macOS: only flag utun when it carries Clash-style fake-ip range
    if (/^utun\d+$/i.test(name)) {
      const hasFakeIp = addrs.some(
        (a) => isIpv4Family(a.family) && !a.internal && isLikelyTunIpv4(a.address)
      )
      if (hasFakeIp) hit.add(name)
    }
  }

  const names = [...hit].sort()
  return { likely: names.length > 0, names }
}
