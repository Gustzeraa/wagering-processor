const TRANSIENT_PG_CODES = new Set(['40001', '40P01', '55P03', '57P01', '53300']);
const TRANSIENT_NET_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);
const TRANSIENT_NAMES = new Set(['LockWaitTimeoutException', 'DeadlockException', 'ConnectionException']);

/** Erro que pode se resolver sozinho se tentarmos de novo. */
export function isTransientError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const e = current as { name?: string; code?: string; cause?: unknown };
    if (e.name && TRANSIENT_NAMES.has(e.name)) return true;
    if (e.code && (TRANSIENT_PG_CODES.has(e.code) || e.code.startsWith('08') || TRANSIENT_NET_CODES.has(e.code))) {
      return true;
    }
    current = e.cause;
  }
  return false;
}