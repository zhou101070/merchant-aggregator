import { describe, expect, it } from 'vitest'
import { detectLikelyTunProxy, isLikelyTunInterfaceName } from '../tun-detect'

describe('tun-detect', () => {
  it('matches common product interface names', () => {
    expect(isLikelyTunInterfaceName('Meta')).toBe(true)
    expect(isLikelyTunInterfaceName('mihomo')).toBe(true)
    expect(isLikelyTunInterfaceName('Clash')).toBe(true)
    expect(isLikelyTunInterfaceName('Wintun')).toBe(true)
    expect(isLikelyTunInterfaceName('sing-box')).toBe(true)
    expect(isLikelyTunInterfaceName('tun0')).toBe(true)
    expect(isLikelyTunInterfaceName('以太网')).toBe(false)
    expect(isLikelyTunInterfaceName('WLAN')).toBe(false)
    expect(isLikelyTunInterfaceName('VMware Network Adapter VMnet1')).toBe(false)
  })

  it('detects by name on win-like ifaces', () => {
    const r = detectLikelyTunProxy({
      Meta: [{ address: '198.18.0.1', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null }],
      WLAN: [{ address: '192.168.1.2', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null }]
    })
    expect(r.likely).toBe(true)
    expect(r.names).toEqual(['Meta'])
  })

  it('ignores bare mac utun without fake-ip', () => {
    const r = detectLikelyTunProxy({
      utun0: [{ address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '', internal: false, cidr: null, scopeid: 0 }],
      en0: [{ address: '192.168.1.5', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null }]
    })
    expect(r.likely).toBe(false)
  })

  it('flags mac utun with clash fake-ip range', () => {
    const r = detectLikelyTunProxy({
      utun4: [
        { address: '198.18.0.1', netmask: '255.255.0.0', family: 'IPv4', mac: '', internal: false, cidr: null }
      ]
    })
    expect(r.likely).toBe(true)
    expect(r.names).toEqual(['utun4'])
  })
})
