export type AppErrorCode =
  | 'NETWORK'
  | 'TIMEOUT'
  | 'RATE_LIMIT'
  | 'DEGRADED'
  | 'SCHEMA_VALIDATION'
  | 'NEED_BROWSER'
  | 'CANCELLED'
  | 'NOT_FOUND'
  | 'INVALID_URL'
  | 'SYNC_LOCKED'
  | 'PAUSED'
  | 'INTERNAL'

export interface AppErrorDTO {
  code: AppErrorCode
  message: string
  details?: unknown
}

export class AppError extends Error {
  readonly code: AppErrorCode
  readonly details?: unknown

  constructor(code: AppErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.details = details
  }

  toDTO(): AppErrorDTO {
    return {
      code: this.code,
      message: this.message,
      details: this.details
    }
  }
}
