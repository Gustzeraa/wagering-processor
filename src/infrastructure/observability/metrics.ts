import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { WagerTransaction } from '../../domain/wager-transaction';
import { IdempotencyConflictError } from '../../domain/errors';

export const registry = new Registry();

export const wagerTransactions = new Counter({
  name: 'wager_transactions_total',
  help: 'Wager transactions by final status',
  labelNames: ['source', 'kind', 'status', 'failure_code'] as const,
  registers: [registry],
});

export const wagerDuplicates = new Counter({
  name: 'wager_duplicates_total',
  help: 'Duplicates detected (replays and payload conflicts)',
  labelNames: ['source', 'outcome'] as const,
  registers: [registry],
});

export const retries = new Counter({
  name: 'wager_retries_total',
  help: 'Retries scheduled by component',
  labelNames: ['component'] as const,
  registers: [registry],
});

export const dlqMessages = new Counter({
  name: 'wager_dlq_messages_total',
  help: 'Messages sent to the DLQ',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const lockWait = new Histogram({
  name: 'wallet_lock_wait_seconds',
  help: 'Time waiting for the wallet row lock (SELECT ... FOR UPDATE)',
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [registry],
});

export const lockTimeouts = new Counter({
  name: 'wallet_lock_timeouts_total',
  help: 'Wallet lock waits that exceeded lock_timeout',
  registers: [registry],
});

export const processingDuration = new Histogram({
  name: 'wager_processing_duration_seconds',
  help: 'End-to-end processing latency',
  labelNames: ['source', 'kind'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const reconciliationMismatches = new Counter({
  name: 'wallet_reconciliation_mismatches_total',
  help: 'Reconciliations where stored balance differs from the ledger',
  registers: [registry],
});

/** Preenchido pelo MetricsCollector; os gauges consultam na hora do scrape. */
export const gaugeSources: {
  outbox?: () => Promise<{ pending: number; lagSeconds: number }>;
  dlqDepth?: () => Promise<number>;
} = {};

export const outboxPending = new Gauge({
  name: 'outbox_pending',
  help: 'Outbox events not yet published',
  registers: [registry],
  async collect() {
    const stats = await gaugeSources.outbox?.().catch(() => undefined);
    if (stats) this.set(stats.pending);
  },
});

export const outboxLag = new Gauge({
  name: 'outbox_lag_seconds',
  help: 'Age of the oldest unpublished outbox event',
  registers: [registry],
  async collect() {
    const stats = await gaugeSources.outbox?.().catch(() => undefined);
    if (stats) this.set(stats.lagSeconds);
  },
});

export const dlqDepth = new Gauge({
  name: 'wager_dlq_depth',
  help: 'Approximate number of messages in the DLQ',
  registers: [registry],
  async collect() {
    const depth = await gaugeSources.dlqDepth?.().catch(() => undefined);
    if (depth !== undefined) this.set(depth);
  },
});

// ---------- helpers usados nas bordas ----------

export function recordWagerResult(source: string, t: WagerTransaction, replay: boolean, seconds: number): void {
  processingDuration.observe({ source, kind: t.kind }, seconds);
  if (replay) {
    wagerDuplicates.inc({ source: 'idempotency', outcome: 'replay' });
    return;
  }
  wagerTransactions.inc({ source, kind: t.kind, status: t.status, failure_code: t.failureCode ?? 'none' });
}

export function isLockTimeout(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const e = current as { name?: string; code?: string; cause?: unknown };
    if (e.code === '55P03' || e.name === 'LockWaitTimeoutException') return true;
    current = e.cause;
  }
  return false;
}

export function recordWagerError(error: unknown): void {
  if (error instanceof IdempotencyConflictError) {
    wagerDuplicates.inc({ source: 'idempotency', outcome: 'conflict' });
  }
  if (isLockTimeout(error)) lockTimeouts.inc();
}