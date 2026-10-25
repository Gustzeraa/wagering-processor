import type { EntityManager } from '@mikro-orm/postgresql';
import type { Clock, IdGenerator } from './ports';
import type { PendingReferencePolicy } from './pending-reference-policy';
import { Money, type MoneyProps } from '../domain/money';
import { Wallet } from '../domain/wallet';
import { WalletLedgerEntry, LedgerDirection } from '../domain/ledger-entry';
import { FailureCode } from '../domain/failure-code';
import { computePayloadHash } from '../domain/payload-hash';
import { evaluateReference } from '../domain/reference-policy';
import {
  EXTERNAL_KINDS,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../domain/wager-transaction';
import {
  IdempotencyConflictError,
  InsufficientFundsError,
  InvalidWagerTransactionError,
  WalletNotFoundError,
} from '../domain/errors';
import {
  type EventContext,
  type IntegrationEvent,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events';
import type {
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from '../infrastructure/persistence/repositories';
import { addLogContext } from '../infrastructure/observability/log-context';

export interface ProcessWagerCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface RequestContext {
  correlationId: string;
  causationId?: string;
}

export interface WagerResult {
  transaction: WagerTransaction;
  replay: boolean;
}

export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly ledger: LedgerRepository,
    private readonly outbox: OutboxRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly pending: PendingReferencePolicy,
  ) {}

  async execute(cmd: ProcessWagerCommand, tx: EntityManager, ctx: RequestContext): Promise<WagerResult> {
    if (!EXTERNAL_KINDS.includes(cmd.kind as Kind)) {
      throw new InvalidWagerTransactionError(`Unsupported kind: ${cmd.kind}`);
    }
    const money = Money.from(cmd.money);
    const payloadHash = computePayloadHash({ ...cmd, money: money.toJSON() });

    // 1. trava a wallet: tudo daqui em diante acontece em fila para esta wallet
    await tx.execute(`SET LOCAL lock_timeout = '5s'`);
    const wallet = await this.wallets.findByIdForUpdate(tx, cmd.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(cmd.walletId);
    }

    addLogContext({ walletId: cmd.walletId, providerId: cmd.providerId });

    // 2. idempotência: com a wallet travada, uma cópia concorrente já terá sido gravada
    const existing =
      (await this.transactions.findByIdempotencyKey(tx, cmd.idempotencyKey)) ??
      (await this.transactions.findByProviderExternalId(tx, cmd.providerId, cmd.externalTransactionId));
    if (existing) {
      addLogContext({ transactionId: existing.id });
      if (existing.idempotencyKey === cmd.idempotencyKey && existing.matchesPayload(payloadHash)) {
        return { transaction: existing, replay: true };
      }
      throw new IdempotencyConflictError(cmd.idempotencyKey);
    }

    // 3. cria e decide
    const now = this.clock.now();
    const transaction = WagerTransaction.create({
      id: this.ids.next(),
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      payloadHash,
      walletId: cmd.walletId,
      playerId: cmd.playerId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind as Kind,
      money,
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
      createdAt: now,
    });
    addLogContext({ transactionId: transaction.id });

    const entry = await this.decide(tx, transaction, wallet, now);

    // 4. grava tudo no Unit of Work; o commit acontece quando a transação termina
    this.transactions.add(tx, transaction);
    if (entry) {
      this.ledger.add(tx, entry);
      await this.wallets.update(tx, wallet);
    }
    for (const event of this.eventsFor(transaction, wallet, entry, ctx)) {
      this.outbox.add(tx, event);
    }

    return { transaction, replay: false };
  }

  private async decide(
    tx: EntityManager,
    t: WagerTransaction,
    wallet: Wallet,
    now: Date,
  ): Promise<WalletLedgerEntry | undefined> {
    if (t.playerId !== wallet.playerId) {
      t.reject(FailureCode.WalletMismatch, wallet.balance);
      return undefined;
    }
    if (t.money.currency !== wallet.currency) {
      t.reject(FailureCode.CurrencyMismatch, wallet.balance);
      return undefined;
    }

    let reference: WagerTransaction | undefined;
    if (t.referenceExternalTransactionId !== undefined) {
      const found = await this.transactions.findByProviderExternalId(
        tx,
        t.providerId,
        t.referenceExternalTransactionId,
      );
      const reversed =
        found && t.requiresReference() ? await this.transactions.hasProcessedReversal(tx, found.id) : false;
      const decision = evaluateReference(t, found, reversed);

      if (decision.outcome === 'wait') {
        t.markPendingReference(this.pending.nextAttempt(now, 0));
        return undefined;
      }
      if (decision.outcome === 'reject') {
        t.reject(decision.code, wallet.balance);
        return undefined;
      }
      reference = decision.reference;
    }

    return this.apply(t, wallet, reference, now);
  }

  /** Aplica no saldo. Também é usado pelo worker de pendentes. */
  apply(
    t: WagerTransaction,
    wallet: Wallet,
    reference: WagerTransaction | undefined,
    now: Date,
  ): WalletLedgerEntry | undefined {
    if (!t.affectsBalance()) {
      t.markProcessed(reference?.id, wallet.balance, now);
      return undefined;
    }

    const movement = { transactionId: t.id, entryId: this.ids.next(), at: now };
    try {
      const entry =
        t.ledgerDirectionFor(reference) === LedgerDirection.Debit
          ? wallet.debit(t.money, movement)
          : wallet.credit(t.money, movement);
      t.markProcessed(reference?.id, wallet.balance, now);
      return entry;
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        t.reject(
          t.kind === Kind.Rollback ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds,
          wallet.balance,
        );
        return undefined;
      }
      throw error;
    }
  }

  eventsFor(
    t: WagerTransaction,
    wallet: Wallet,
    entry: WalletLedgerEntry | undefined,
    ctx: RequestContext,
  ): IntegrationEvent<unknown>[] {
    const eventCtx: EventContext = {
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      eventId: () => this.ids.next(),
      now: () => this.clock.now(),
    };
    switch (t.status) {
      case Status.Processed:
        return [
          WagerTransactionProcessed.from(t, eventCtx),
          ...(entry ? [WalletBalanceChanged.from(wallet, entry, eventCtx)] : []),
        ];
      case Status.Rejected:
        return [WagerTransactionRejected.from(t, eventCtx)];
      case Status.PendingReference:
        return [WagerTransactionPendingReference.from(t, eventCtx)];
      default:
        return [];
    }
  }
}