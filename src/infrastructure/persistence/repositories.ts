import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { Wallet } from '../../domain/wallet';
import { WalletLedgerEntry } from '../../domain/ledger-entry';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction';
import { LedgerEntryRecord, WagerTransactionRecord, WalletRecord } from './records';
import {
  applyTransaction,
  applyWallet,
  ledgerToRecord,
  toLedgerEntry,
  toTransaction,
  toWallet,
  transactionToRecord,
  walletToRecord,
} from './mappers';
import { OutboxMessageRecord } from './records';
import type { IntegrationEvent } from '../../domain/events';

export class WalletRepository {
  /** SELECT ... FOR UPDATE: trava a wallet até o fim da transação. */
  async findByIdForUpdate(tx: EntityManager, id: string): Promise<Wallet | null> {
    const r = await tx.findOne(WalletRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return r ? toWallet(r) : null;
  }

  async findById(tx: EntityManager, id: string): Promise<Wallet | null> {
    const r = await tx.findOne(WalletRecord, { id });
    return r ? toWallet(r) : null;
  }

  add(tx: EntityManager, wallet: Wallet): void {
    tx.persist(walletToRecord(wallet));
  }

  /** O record já está no Identity Map desta transação; não faz nova consulta. */
  async update(tx: EntityManager, wallet: Wallet): Promise<void> {
    const r = await tx.findOneOrFail(WalletRecord, { id: wallet.id });
    applyWallet(wallet, r);
  }
}

export class WagerTransactionRepository {
  async findByIdempotencyKey(tx: EntityManager, key: string): Promise<WagerTransaction | null> {
    const r = await tx.findOne(WagerTransactionRecord, { idempotencyKey: key });
    return r ? toTransaction(r) : null;
  }

  async findByProviderExternalId(
    tx: EntityManager,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const r = await tx.findOne(WagerTransactionRecord, { providerId, externalTransactionId });
    return r ? toTransaction(r) : null;
  }

  async findById(tx: EntityManager, id: string): Promise<WagerTransaction | null> {
    const r = await tx.findOne(WagerTransactionRecord, { id });
    return r ? toTransaction(r) : null;
  }

  async hasProcessedReversal(tx: EntityManager, referenceTransactionId: string): Promise<boolean> {
    const count = await tx.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  add(tx: EntityManager, t: WagerTransaction): void {
    tx.persist(transactionToRecord(t));
  }

  async update(tx: EntityManager, t: WagerTransaction): Promise<void> {
    const r = await tx.findOneOrFail(WagerTransactionRecord, { id: t.id });
    applyTransaction(t, r);
  }
}

export class LedgerRepository {
  add(tx: EntityManager, entry: WalletLedgerEntry): void {
    tx.persist(ledgerToRecord(entry));
  }

  async listByWallet(tx: EntityManager, walletId: string): Promise<WalletLedgerEntry[]> {
    const rows = await tx.find(LedgerEntryRecord, { walletId }, { orderBy: { walletVersion: 'asc' } });
    return rows.map(toLedgerEntry);
  }
}

export class OutboxRepository {
  add(tx: EntityManager, event: IntegrationEvent<unknown>): void {
    tx.persist(
      Object.assign(new OutboxMessageRecord(), {
        id: event.eventId,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: event.toJSON() as unknown as Record<string, unknown>,
        occurredAt: event.occurredAt,
        attempts: 0,
        nextAttemptAt: null,
        publishedAt: null,
      }),
    );
  }
}