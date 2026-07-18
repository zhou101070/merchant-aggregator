import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isVerifiedAssetMetadataCurrent,
  parseVerifiedAssetRecord,
  sha256File
} from '../proxy-core-integrity'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('sha256File', () => {
  it('computes a stable digest for downloaded bytes', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ma-proxy-integrity-'))
    dirs.push(dir)
    const file = path.join(dir, 'asset.bin')
    writeFileSync(file, 'mihomo-test')
    await expect(sha256File(file)).resolves.toBe(
      '537accbc7bb0553057b6e4a70ea5e54cf0c4051749aa782968c3dfa1ba62d5f9'
    )
  })
})

describe('parseVerifiedAssetRecord', () => {
  const archiveSha256 = 'a'.repeat(64)
  const binarySha256 = 'b'.repeat(64)

  it('accepts archiveSha256 + binarySha256 records', () => {
    expect(
      parseVerifiedAssetRecord({
        version: 'v1.19.12',
        file: 'mihomo.zip',
        archiveSha256,
        binarySha256
      })
    ).toEqual({
      version: 'v1.19.12',
      file: 'mihomo.zip',
      archiveSha256,
      binarySha256
    })
  })

  it('rejects legacy archive-only records without binary digest', () => {
    expect(
      parseVerifiedAssetRecord({
        version: 'v1.19.12',
        file: 'mihomo.zip',
        sha256: archiveSha256
      })
    ).toBeNull()
  })

  it('rejects malformed digests', () => {
    expect(
      parseVerifiedAssetRecord({
        version: 'v1.19.12',
        file: 'mihomo.zip',
        archiveSha256: 'not-a-hash',
        binarySha256
      })
    ).toBeNull()
  })
})

describe('isVerifiedAssetMetadataCurrent', () => {
  const record = {
    version: 'v1.19.12',
    file: 'mihomo.zip',
    archiveSha256: 'a'.repeat(64),
    binarySha256: 'b'.repeat(64)
  }

  it('requires version, file, and pinned archive digest to match', () => {
    expect(
      isVerifiedAssetMetadataCurrent(record, {
        version: 'v1.19.12',
        file: 'mihomo.zip',
        expectedArchiveSha256: record.archiveSha256
      })
    ).toBe(true)
    expect(
      isVerifiedAssetMetadataCurrent(record, {
        version: 'v1.19.12',
        file: 'other.zip',
        expectedArchiveSha256: record.archiveSha256
      })
    ).toBe(false)
    expect(
      isVerifiedAssetMetadataCurrent(record, {
        version: 'v1.19.12',
        file: 'mihomo.zip',
        expectedArchiveSha256: null
      })
    ).toBe(false)
  })
})
