import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/ledger-entry';
import type { WagerTransaction } from '../domain/wager-transaction';

export const presentWallet = (w: Wallet) => ({
  id: w.id,
  playerId: w.playerId,
  balance: w.balance.toJSON(),
  version: w.version,
});

export const presentSubmission = (t: WagerTransaction, replay: boolean) => ({
  transactionId: t.id,
  status: t.status,
  ...(t.balanceAfter ? { balance: t.balanceAfter.toJSON() } : {}),
  ...(t.failureCode ? { failureCode: t.failureCode } : {}),
  idempotentReplay: replay,
});

export const presentTransaction = (t: WagerTransaction) => ({
  id: t.id,
  providerId: t.providerId,
  externalTransactionId: t.externalTransactionId,
  walletId: t.walletId,
  playerId: t.playerId,
  roundId: t.roundId,
  gameId: t.gameId,
  kind: t.kind,
  money: t.money.toJSON(),
  status: t.status,
  failureCode: t.failureCode,
  referenceExternalTransactionId: t.referenceExternalTransactionId,
  referenceTransactionId: t.referenceTransactionId,
  balanceAfter: t.balanceAfter?.toJSON(),
  createdAt: t.createdAt.toISOString(),
  processedAt: t.processedAt?.toISOString(),
});

export const presentLedgerEntry = (e: WalletLedgerEntry) => ({
  id: e.id,
  transactionId: e.transactionId,
  direction: e.direction,
  money: e.money.toJSON(),
  balanceBefore: e.balanceBefore.toJSON(),
  balanceAfter: e.balanceAfter.toJSON(),
  walletVersion: e.walletVersion,
  createdAt: e.createdAt.toISOString(),
});