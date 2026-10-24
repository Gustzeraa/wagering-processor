export interface PendingReferencePolicy {
  nextAttempt(now: Date, attempts: number): Date;
  isExpired(createdAt: Date, now: Date): boolean;
}

export function pendingReferencePolicy(
  ttlMs = Number(process.env.PENDING_REFERENCE_TTL_MS ?? 30 * 60_000),
): PendingReferencePolicy {
  return {
    nextAttempt: (now, attempts) => new Date(now.getTime() + Math.min(1000 * 2 ** attempts, 60_000)),
    isExpired: (createdAt, now) => now.getTime() - createdAt.getTime() >= ttlMs,
  };
}