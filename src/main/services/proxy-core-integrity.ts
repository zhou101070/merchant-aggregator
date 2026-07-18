import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync } from 'node:fs'

export type VerifiedAssetRecord = {
  version: string
  file: string
  archiveSha256: string
  binarySha256: string
}

export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(filePath)
    input.on('data', (chunk) => hash.update(chunk))
    input.once('error', reject)
    input.once('end', () => resolve(hash.digest('hex')))
  })
}

export function parseVerifiedAssetRecord(raw: unknown): VerifiedAssetRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const version = typeof o.version === 'string' ? o.version : ''
  const file = typeof o.file === 'string' ? o.file : ''
  const archiveSha256 =
    typeof o.archiveSha256 === 'string'
      ? o.archiveSha256
      : typeof o.sha256 === 'string'
        ? o.sha256
        : ''
  const binarySha256 = typeof o.binarySha256 === 'string' ? o.binarySha256 : ''
  if (!version || !file || !/^[a-f0-9]{64}$/.test(archiveSha256)) return null
  if (!/^[a-f0-9]{64}$/.test(binarySha256)) return null
  return { version, file, archiveSha256, binarySha256 }
}

export function readVerifiedAssetRecord(filePath: string): VerifiedAssetRecord | null {
  try {
    if (!existsSync(filePath)) return null
    return parseVerifiedAssetRecord(JSON.parse(readFileSync(filePath, 'utf8')))
  } catch {
    return null
  }
}

/** Metadata match only — does not re-hash the installed binary. */
export function isVerifiedAssetMetadataCurrent(
  record: VerifiedAssetRecord | null,
  opts: { version: string; file: string; expectedArchiveSha256: string | null }
): boolean {
  if (!record || !opts.expectedArchiveSha256) return false
  return (
    record.version === opts.version &&
    record.file === opts.file &&
    record.archiveSha256 === opts.expectedArchiveSha256
  )
}
