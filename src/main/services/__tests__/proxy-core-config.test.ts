import { describe, expect, it } from 'vitest'
import {
  buildMihomoConfig,
  mihomoAssetName,
  mihomoAssetSha256,
  mihomoBinaryName,
  mihomoDownloadUrls,
  mihomoGroupName,
  mihomoProviderKey
} from '../proxy-core-config'

describe('proxy-core-config', () => {
  it('builds multi-subscription load-balance config', () => {
    const yaml = buildMihomoConfig({
      mixedPort: 17890,
      controllerPort: 19090,
      secret: 'abc"def',
      subscriptions: [
        { id: 'a1', url: 'https://example.com/sub?token=1', name: 'A' },
        { id: 'b2', url: 'https://example.com/sub2', name: 'B' }
      ]
    })
    expect(yaml).toContain('mixed-port: 17890')
    expect(yaml).toContain('external-controller: 127.0.0.1:19090')
    expect(yaml).toContain(mihomoProviderKey('a1'))
    expect(yaml).toContain(mihomoProviderKey('b2'))
    expect(yaml).toContain(mihomoGroupName('a1'))
    expect(yaml).toContain(mihomoGroupName('b2'))
    expect(yaml).toContain('name: MA-LB')
    expect(yaml).toContain('type: load-balance')
    expect(yaml).toContain('strategy: round-robin')
    expect(yaml).toContain('https://example.com/sub?token=1')
    expect(yaml).toContain('secret: "abc\\"def"')
  })

  it('adds MA-ROOT selector with MA-LB default and all providers', () => {
    const yaml = buildMihomoConfig({
      mixedPort: 17890,
      controllerPort: 19090,
      secret: 's3cretpass',
      subscriptions: [
        { id: 'a1', url: 'https://example.com/sub', name: 'A' },
        { id: 'b2', url: 'https://example.com/sub2', name: 'B' }
      ]
    })
    expect(yaml).toContain('name: MA-ROOT')
    expect(yaml).toContain('type: select')
    expect(yaml).toContain('MATCH,MA-ROOT')
    expect(yaml).not.toContain('MATCH,MA-LB')
    // selector must not remember pinned node across restarts
    expect(yaml).toContain('store-selected: false')
    // MA-LB listed first → default selection keeps load-balance behavior
    const rootIdx = yaml.indexOf('name: MA-ROOT')
    const lbInRoot = yaml.indexOf('- MA-LB', rootIdx)
    expect(lbInRoot).toBeGreaterThan(rootIdx)
  })

  it('picks platform assets', () => {
    expect(mihomoAssetName('win32', 'x64', 'v1.19.12')).toEqual({
      file: 'mihomo-windows-amd64-v2-v1.19.12.zip',
      kind: 'zip'
    })
    expect(mihomoAssetName('win32', 'arm64', 'v1.19.12')).toEqual({
      file: 'mihomo-windows-arm64-v1.19.12.zip',
      kind: 'zip'
    })
    expect(mihomoAssetName('darwin', 'arm64', 'v1.19.12')).toEqual({
      file: 'mihomo-darwin-arm64-v1.19.12.gz',
      kind: 'gz'
    })
    expect(mihomoBinaryName('win32')).toBe('mihomo.exe')
    expect(mihomoBinaryName('linux')).toBe('mihomo')
  })

  it('lists github then mainland mirrors', () => {
    const urls = mihomoDownloadUrls('v1.19.12', 'mihomo-windows-amd64-v2-v1.19.12.zip')
    expect(urls[0]).toBe(
      'https://github.com/MetaCubeX/mihomo/releases/download/v1.19.12/mihomo-windows-amd64-v2-v1.19.12.zip'
    )
    expect(urls[1]).toContain('ghfast.top')
    expect(urls[2]).toContain('ghproxy.net')
  })

  it('pins official SHA-256 digests for every supported release asset', () => {
    const targets: Array<[NodeJS.Platform, string]> = [
      ['win32', 'x64'],
      ['win32', 'arm64'],
      ['darwin', 'x64'],
      ['darwin', 'arm64'],
      ['linux', 'x64'],
      ['linux', 'arm64']
    ]
    for (const [platform, arch] of targets) {
      const { file } = mihomoAssetName(platform, arch, 'v1.19.12')
      expect(mihomoAssetSha256('v1.19.12', file)).toMatch(/^[a-f0-9]{64}$/)
    }
    expect(mihomoAssetSha256('v0.0.0', 'unknown.zip')).toBeNull()
  })
})
