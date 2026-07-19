import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => []
  }
}))

import {
  beginSyncHttpRequest,
  clearSyncHttpRequests,
  endSyncHttpRequest,
  enterSyncRequestScope,
  leaveSyncRequestScope,
  listSyncHttpRequests
} from '../sync-request-log'

describe('sync-request-log', () => {
  beforeEach(() => {
    clearSyncHttpRequests()
    leaveSyncRequestScope('job-a')
    leaveSyncRequestScope('job-b')
  })

  it('ignores requests outside sync scope', () => {
    expect(beginSyncHttpRequest({ method: 'GET', url: 'https://a.example/x' })).toBeNull()
    expect(listSyncHttpRequests()).toEqual([])
  })

  it('records start/end with duration and status', () => {
    enterSyncRequestScope('job-a')
    const id = beginSyncHttpRequest({
      method: 'get',
      url: 'https://priceai.cc/api/merchants?limit=1'
    })
    expect(id).toBeTruthy()
    let rows = listSyncHttpRequests()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      method: 'GET',
      host: 'priceai.cc',
      phase: 'pending',
      node: '直连',
      jobId: 'job-a'
    })
    endSyncHttpRequest(id, { status: 200 })
    rows = listSyncHttpRequests()
    expect(rows[0]?.phase).toBe('done')
    expect(rows[0]?.status).toBe(200)
    expect(typeof rows[0]?.durationMs).toBe('number')
    leaveSyncRequestScope('job-a')
  })

  it('skips localhost controller traffic', () => {
    enterSyncRequestScope('job-a')
    expect(beginSyncHttpRequest({ url: 'http://127.0.0.1:9090/connections' })).toBeNull()
    expect(listSyncHttpRequests()).toEqual([])
    leaveSyncRequestScope('job-a')
  })

  it('clears buffer when a new scope starts after idle', () => {
    enterSyncRequestScope('job-a')
    beginSyncHttpRequest({ url: 'https://a.example/1' })
    leaveSyncRequestScope('job-a')
    enterSyncRequestScope('job-b')
    expect(listSyncHttpRequests()).toEqual([])
    beginSyncHttpRequest({ url: 'https://b.example/2' })
    expect(listSyncHttpRequests()).toHaveLength(1)
    expect(listSyncHttpRequests()[0]?.host).toBe('b.example')
    leaveSyncRequestScope('job-b')
  })
})
