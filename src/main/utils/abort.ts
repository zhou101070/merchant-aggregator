import { AppError } from '@shared/types/errors'

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message))
}

export function abortError(message = 'The operation was aborted'): Error {
  const err = new Error(message)
  err.name = 'AbortError'
  return err
}

/**
 * Map AbortError from fetch/sleep:
 * - job/user signal aborted → CANCELLED
 * - otherwise → TIMEOUT (e.g. mainFetch default request timeout)
 *
 * Callers must not treat every AbortError as whole-job cancel.
 */
export function appErrorFromAbort(
  signal: AbortSignal | null | undefined,
  label: string
): AppError {
  if (signal?.aborted) {
    return new AppError('CANCELLED', `${label} cancelled`)
  }
  return new AppError('TIMEOUT', `${label} timeout`)
}

/** Rethrow AppError; map AbortError via signal; leave other errors for caller. */
export function mapAbortError(
  err: unknown,
  signal: AbortSignal | null | undefined,
  label: string
): unknown {
  if (err instanceof AppError) return err
  if (isAbortError(err)) return appErrorFromAbort(signal, label)
  return err
}
