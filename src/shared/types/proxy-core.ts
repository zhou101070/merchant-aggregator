/** Runtime status of the embedded proxy core (mihomo). */
export type ProxyCoreState = 'stopped' | 'starting' | 'running' | 'error'

export interface ProxyCoreStatus {
  state: ProxyCoreState
  /** True when settings.proxyCoreEnabled */
  enabled: boolean
  /** Local mixed HTTP proxy, e.g. http://127.0.0.1:17890 */
  proxyUrl: string | null
  mixedPort: number | null
  controllerPort: number | null
  /** Short message for UI (no secrets) */
  message: string
  /** Last error code if state=error */
  errorCode?: string
  binaryReady: boolean
  hasSubscription: boolean
  /** Heuristic: local TUN-like NIC may be active (soft warning only). */
  tunLikely: boolean
  /** Matched interface names when tunLikely. */
  tunInterfaces: string[]
  /** Active subscription group count used by running config. */
  groupCount: number
  callLogEnabled: boolean
  callLogCount: number
}

export interface ProxyCallLogEntry {
  id: string
  at: number
  group: string
  node: string
  host: string
  network?: string
  upload?: number
  download?: number
}

export interface ProxyNodeInfo {
  name: string
  /** Delay ms from history, if any */
  delay?: number
}

export interface ProxyGroupInfo {
  /** mihomo group name, e.g. MA-G-xxx */
  name: string
  subscriptionId: string
  subscriptionName: string
  type: string
  nodes: ProxyNodeInfo[]
}

/** A node proven unusable for a platform (expires after TTL). */
export interface ProxyBadNodeInfo {
  platformId: string
  nodeName: string
  reason: string | null
  expiresAt: string
}

export interface ProxyCoreDetail {
  status: ProxyCoreStatus
  groups: ProxyGroupInfo[]
  callLogs: ProxyCallLogEntry[]
  callLogEnabled: boolean
  /** 换节点重试确证的平台级不可用节点 */
  badNodes: ProxyBadNodeInfo[]
}

export interface ProxyCoreApplyRequest {
  enabled: boolean
  subscriptions: import('./proxy-subscription').ProxySubscription[]
  callLogEnabled?: boolean
}
