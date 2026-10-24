import { Money } from '../../domain/money';
import { Wallet } from '../../domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/ledger-entry';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction';
import { FailureCode } from '../../domain/failure-code';
import { LedgerEntryRecord, WagerTransactionRecord, WalletRecord } from './records';

const money = (minor: string, currency: string) => Money.fromMinorUnits(BigInt(minor), currency);
const minor = (m: Money) => m.toMinorUnits().toString();

// ---------- wallet ----------

export function toWallet(r: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.playerId,
    currency: r.currency,
    balance: money(r.balance, r.currency),
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

export function walletToRecord(w: Wallet): WalletRecord {
  return Object.assign(new WalletRecord(), {
    id: w.id,
    playerId: w.playerId,
    currency: w.currency,
    balance: minor(w.balance),
    version: w.version,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  });
}

export function applyWallet(w: Wallet, r: WalletRecord): void {
  r.balance = minor(w.balance);
  r.version = w.version;
  r.updatedAt = w.updatedAt;
}

// ---------- wager transaction ----------

export function toTransaction(r: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: r.roundId,
    gameId: r.gameId,
    kind: r.kind as WagerTransactionKind,
    money: money(r.amount, r.currency),
    referenceExternalTransactionId: r.referenceExternalTransactionId ?? undefined,
    createdAt: r.createdAt,
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: r.referenceTransactionId ?? undefined,
    failureCode: (r.failureCode ?? undefined) as FailureCode | undefined,
    processedAt: r.processedAt ?? undefined,
    balanceAfter: r.balanceAfter != null ? money(r.balanceAfter, r.currency) : undefined,
    referenceAttempts: r.referenceAttempts,
    nextReferenceAttemptAt: r.nextReferenceAttemptAt ?? undefined,
  });
}

export function transactionToRecord(t: WagerTransaction): WagerTransactionRecord {
  const r = Object.assign(new WagerTransactionRecord(), {
    id: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    idempotencyKey: t.idempotencyKey,
    payloadHash: t.payloadHash,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    amount: minor(t.money),
    currency: t.money.currency,
    referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
    createdAt: t.createdAt,
  });
  applyTransaction(t, r);
  return r;
}

/** Só os campos que podem mudar. O trigger do banco recusa qualquer outro. */
export function applyTransaction(t: WagerTransaction, r: WagerTransactionRecord): void {
  r.status = t.status;
  r.referenceTransactionId = t.referenceTransactionId ?? null;
  r.failureCode = t.failureCode ?? null;
  r.processedAt = t.processedAt ?? null;
  r.balanceAfter = t.balanceAfter ? minor(t.balanceAfter) : null;
  r.referenceAttempts = t.referenceAttempts;
  r.nextReferenceAttemptAt = t.nextReferenceAttemptAt ?? null;
}

// ---------- ledger ----------

export function ledgerToRecord(e: WalletLedgerEntry): LedgerEntryRecord {
  return Object.assign(new LedgerEntryRecord(), {
    id: e.id,
    walletId: e.walletId,
    transactionId: e.transactionId,
    direction: e.direction,
    amount: minor(e.money),
    currency: e.money.currency,
    balanceBefore: minor(e.balanceBefore),
    balanceAfter: minor(e.balanceAfter),
    walletVersion: e.walletVersion,
    createdAt: e.createdAt,
  });
}

export function toLedgerEntry(r: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.walletId,
    transactionId: r.transactionId,
    direction: r.direction as LedgerDirection,
    money: money(r.amount, r.currency),
    balanceBefore: money(r.balanceBefore, r.currency),
    balanceAfter: money(r.balanceAfter, r.currency),
    walletVersion: r.walletVersion,
    createdAt: r.createdAt,
  });
}