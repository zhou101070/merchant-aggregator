type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
}

const envLevel = (process.env.MA_LOG_LEVEL ?? 'info').toLowerCase() as LogLevel
const minLevel = LEVEL_ORDER[envLevel] ?? LEVEL_ORDER.info

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= minLevel
}

function formatMessage(scope: string, message: string): string {
  return `[${new Date().toISOString()}] [${scope}] ${message}`
}

function write(level: LogLevel, scope: string, message: string, meta?: unknown): void {
  if (!shouldLog(level)) return
  const line = formatMessage(scope, message)
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  if (meta === undefined) {
    fn(line)
  } else {
    fn(line, meta)
  }
}

export interface Logger {
  debug: (message: string, meta?: unknown) => void
  info: (message: string, meta?: unknown) => void
  warn: (message: string, meta?: unknown) => void
  error: (message: string, meta?: unknown) => void
  child: (childScope: string) => Logger
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, meta) => write('debug', scope, message, meta),
    info: (message, meta) => write('info', scope, message, meta),
    warn: (message, meta) => write('warn', scope, message, meta),
    error: (message, meta) => write('error', scope, message, meta),
    child: (childScope) => createLogger(`${scope}:${childScope}`)
  }
}

export const rootLogger = createLogger('ma')
