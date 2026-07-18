/**
 * Generate mihomo config: multi subscription providers + per-sub LB groups + root MA-LB.
 * All traffic through mixed-port uses MA-LB (round-robin across groups).
 */

export type MihomoSubInput = {
  id: string
  url: string
  name: string
}

export function mihomoProviderKey(id: string): string {
  return `ma-sub-${id}`
}

export function mihomoGroupName(id: string): string {
  return `MA-G-${id}`
}

/** Root select group: [MA-LB, ...all nodes]. App pins a node here on retry. */
export const MIHOMO_ROOT_GROUP = 'MA-ROOT'
export const MIHOMO_LB_GROUP = 'MA-LB'

/** SHA-256 digests published by the official MetaCubeX v1.19.12 GitHub release. */
const MIHOMO_ASSET_SHA256: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'v1.19.12': {
    'mihomo-windows-amd64-v2-v1.19.12.zip':
      'e3ba027866bc184f74114dd0aaf4d44439a09f54f50f61b833b54180a0382f7e',
    'mihomo-windows-arm64-v1.19.12.zip':
      '572bc2f03d7114f4a51f300e65c4e4d320f4ad3c785040cedbcb53a17e540b3a',
    'mihomo-darwin-amd64-v1.19.12.gz':
      '6dd7b1b867c88308548dec360c1d23f0502bc7d4a5cb91044beb03805b061bd0',
    'mihomo-darwin-arm64-v1.19.12.gz':
      'd80416080bee3ba377e1c35c056d6ac25660855794dba3cfb97c3dba747b299b',
    'mihomo-linux-amd64-v1.19.12.gz':
      'ab666e6e7feec707836d0858bd9955343a82e119108e6c4399269c678e5c6303',
    'mihomo-linux-arm64-v1.19.12.gz':
      'fcb9e294f492eb9df9bca4e1f9c66a383f5e8eef1da7cd20ae5ac3d093fdaaf1'
  }
}

export function mihomoAssetSha256(version: string, file: string): string | null {
  return MIHOMO_ASSET_SHA256[version]?.[file] ?? null
}

function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function buildMihomoConfig(opts: {
  mixedPort: number
  controllerPort: number
  secret: string
  subscriptions: MihomoSubInput[]
}): string {
  const lines: string[] = [
    `mixed-port: ${opts.mixedPort}`,
    'allow-lan: false',
    'bind-address: 127.0.0.1',
    'mode: rule',
    'log-level: warning',
    'ipv6: true',
    `external-controller: 127.0.0.1:${opts.controllerPort}`,
    `secret: ${yamlQuote(opts.secret)}`,
    // Node pinning is session-scoped: do not persist selector choice across restarts
    'profile:',
    '  store-selected: false',
    '',
    'proxy-providers:'
  ]

  for (const sub of opts.subscriptions) {
    const key = mihomoProviderKey(sub.id)
    lines.push(
      `  ${key}:`,
      '    type: http',
      `    url: ${yamlQuote(sub.url)}`,
      `    path: ./providers/${key}.yaml`,
      '    interval: 3600',
      '    health-check:',
      '      enable: true',
      '      url: https://www.gstatic.com/generate_204',
      '      interval: 600',
      '      lazy: true',
      ''
    )
  }

  lines.push('proxy-groups:')

  const groupNames: string[] = []
  for (const sub of opts.subscriptions) {
    const g = mihomoGroupName(sub.id)
    groupNames.push(g)
    lines.push(
      `  - name: ${g}`,
      '    type: load-balance',
      '    strategy: round-robin',
      '    url: https://www.gstatic.com/generate_204',
      '    interval: 300',
      '    lazy: true',
      '    use:',
      `      - ${mihomoProviderKey(sub.id)}`,
      ''
    )
  }

  lines.push(
    `  - name: ${MIHOMO_LB_GROUP}`,
    '    type: load-balance',
    '    strategy: round-robin',
    '    url: https://www.gstatic.com/generate_204',
    '    interval: 300',
    '    lazy: true',
    '    proxies:'
  )
  for (const g of groupNames) {
    lines.push(`      - ${g}`)
  }

  // Root selector: default MA-LB (load-balance untouched); retry logic pins a
  // concrete node via PUT /proxies/MA-ROOT, then restores MA-LB.
  lines.push(
    `  - name: ${MIHOMO_ROOT_GROUP}`,
    '    type: select',
    '    proxies:',
    `      - ${MIHOMO_LB_GROUP}`,
    '    use:'
  )
  for (const sub of opts.subscriptions) {
    lines.push(`      - ${mihomoProviderKey(sub.id)}`)
  }

  lines.push('', 'rules:', `  - MATCH,${MIHOMO_ROOT_GROUP}`, '')
  return lines.join('\n')
}

/** Asset name for MetaCubeX/mihomo releases (filenames embed the tag, e.g. v1.19.12). */
export function mihomoAssetName(
  platform: NodeJS.Platform,
  arch: string,
  version: string
): { file: string; kind: 'zip' | 'gz' } {
  const a = arch === 'arm64' ? 'arm64' : 'amd64'
  if (platform === 'win32') {
    // amd64 uses GOAMD64=v2 build; arm64 has no -v2 infix
    const base =
      a === 'amd64' ? `mihomo-windows-amd64-v2-${version}` : `mihomo-windows-arm64-${version}`
    return { file: `${base}.zip`, kind: 'zip' }
  }
  if (platform === 'darwin') {
    return { file: `mihomo-darwin-${a}-${version}.gz`, kind: 'gz' }
  }
  return { file: `mihomo-linux-${a}-${version}.gz`, kind: 'gz' }
}

/** GitHub first, then mainland-friendly gh mirrors (full asset URL rewritten). */
export function mihomoDownloadUrls(version: string, file: string): string[] {
  const path = `MetaCubeX/mihomo/releases/download/${version}/${file}`
  const github = `https://github.com/${path}`
  return [github, `https://ghfast.top/${github}`, `https://ghproxy.net/${github}`]
}

export function mihomoBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'mihomo.exe' : 'mihomo'
}
