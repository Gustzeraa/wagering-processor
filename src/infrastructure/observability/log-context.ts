import { AsyncLocalStorage } from 'node:async_hooks';

export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Executa fn com um contexto próprio; todo log dentro dela leva esses campos. */
export function runWithLogContext<T>(ctx: LogContext, fn: () => T): T {
  return storage.run({ ...ctx }, fn);
}

/** Acrescenta campos ao contexto atual (ex.: quando o transactionId fica conhecido). */
export function addLogContext(patch: LogContext): void {
  const store = storage.getStore();
  if (store) Object.assign(store, patch);
}

export function currentLogContext(): LogContext {
  return storage.getStore() ?? {};
}