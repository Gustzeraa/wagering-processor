import { describe, expect, it } from 'bun:test';
import { Money } from '../../src/domain/money';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import { FailureCode } from '../../src/domain/failure-code';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from '../../src/domain/errors';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/wager-transaction';
import { computePayloadHash } from '../../src/domain/payload-hash';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-10-24T12:00:00.000Z');

const tx = (kind: Kind, overrides: Partial<{ amount: string; ref: string }> = {}) =>
  WagerTransaction.create({
    id: `id-${kind}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${kind}`,
    idempotencyKey: `provider-a:ext-${kind}`,
    payloadHash: 'hash',
    walletId: 'w-1',
    playerId: 'p-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl(overrides.amount ?? '10.00'),
    referenceExternalTransactionId: overrides.ref,
    createdAt: at,
  });

describe('WagerTransaction creation', () => {
  it('starts as PENDING', () => {
    expect(tx(Kind.Bet).status).toBe(Status.Pending);
  });

  it.each([Kind.Refund, Kind.Rollback])('%s requires a reference', (kind) => {
    expect(() => tx(kind)).toThrow(InvalidWagerTransactionError);
  });

  it('BET cannot have a reference', () => {
    expect(() => tx(Kind.Bet, { ref: 'x' })).toThrow(InvalidWagerTransactionError);
  });

  it('WIN may have a reference', () => {
    expect(tx(Kind.Win, { ref: 'bet-1' }).referenceExternalTransactionId).toBe('bet-1');
  });

  it('LOSS accepts zero, BET does not', () => {
    expect(tx(Kind.Loss, { amount: '0.00' }).status).toBe(Status.Pending);
    expect(() => tx(Kind.Bet, { amount: '0.00' })).toThrow(InvalidWagerTransactionError);
  });
});

describe('WagerTransaction state machine', () => {
  it('PENDING -> PROCESSED stores balance and date', () => {
    const t = tx(Kind.Bet);
    t.markProcessed(undefined, brl('90.00'), at);
    expect(t.status).toBe(Status.Processed);
    expect(t.balanceAfter?.toString()).toBe('90.00');
    expect(t.processedAt).toEqual(at);
  });

  it('PENDING -> PENDING_REFERENCE -> PROCESSED', () => {
    const t = tx(Kind.Rollback, { ref: 'bet-1' });
    t.markPendingReference(at);
    expect(t.status).toBe(Status.PendingReference);
    t.scheduleReferenceRetry(at);
    expect(t.referenceAttempts).toBe(1);
    t.markProcessed('internal-bet-id', brl('100.00'), at);
    expect(t.status).toBe(Status.Processed);
    expect(t.referenceTransactionId).toBe('internal-bet-id');
  });

  it('reject stores failure code', () => {
    const t = tx(Kind.Bet);
    t.reject(FailureCode.InsufficientFunds, brl('20.00'));
    expect(t.status).toBe(Status.Rejected);
    expect(t.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  it('terminal states never change', () => {
    const t = tx(Kind.Bet);
    t.reject(FailureCode.InsufficientFunds, brl('20.00'));
    expect(() => t.markProcessed(undefined, brl('0.00'), at)).toThrow(InvalidTransactionStateError);
    expect(() => t.fail(FailureCode.ProcessingFailed)).toThrow(InvalidTransactionStateError);
    expect(() => t.markPendingReference(at)).toThrow(InvalidTransactionStateError);
  });

  it('cannot be processed without resolving the reference', () => {
    const t = tx(Kind.Refund, { ref: 'bet-1' });
    expect(() => t.markProcessed(undefined, brl('0.00'), at)).toThrow(InvalidTransactionStateError);
  });
});

describe('ledger direction', () => {
  it('maps fixed directions', () => {
    expect(tx(Kind.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(tx(Kind.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(tx(Kind.Refund, { ref: 'b' }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(tx(Kind.Loss).affectsBalance()).toBe(false);
  });

  it('ROLLBACK inverts the referenced direction', () => {
    const rollback = tx(Kind.Rollback, { ref: 'x' });
    expect(rollback.ledgerDirectionFor(tx(Kind.Bet))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(tx(Kind.Win))).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(tx(Kind.Refund, { ref: 'b' }))).toBe(LedgerDirection.Debit);
  });
});

describe('payload hash', () => {
  const base = {
    providerId: 'provider-a', externalTransactionId: 'tx-1', playerId: 'p-1',
    walletId: 'w-1', roundId: 'r-1', gameId: 'g-1', kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };

  it('is stable regardless of key order', () => {
    const reordered = {
      money: { currency: 'BRL', amount: '25.00' }, kind: 'BET', gameId: 'g-1',
      roundId: 'r-1', walletId: 'w-1', playerId: 'p-1',
      externalTransactionId: 'tx-1', providerId: 'provider-a',
    };
    expect(computePayloadHash(reordered)).toBe(computePayloadHash(base));
  });

  it('detects a divergent payload with the same key', () => {
    const changed = { ...base, money: { amount: '50.00', currency: 'BRL' } };
    expect(computePayloadHash(changed)).not.toBe(computePayloadHash(base));
  });

  it('ignores extra non-business fields', () => {
    const withExtra = { ...base, sentAt: '2026-10-24' } as typeof base;
    expect(computePayloadHash(withExtra)).toBe(computePayloadHash(base));
  });
});