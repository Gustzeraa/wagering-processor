import type { MoneyProps } from './money';
import type { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import type { Wallet } from './wallet';
import type { WagerTransaction } from './wager-transaction';

export interface EventContext {
  correlationId: string;
  causationId?: string;
  eventId: () => string;
  now: () => Date;
}

interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = Object.freeze({ ...props.data });
  }

  toJSON() {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      causationId: this.causationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
  }
}

const envelope = (aggregateId: string, ctx: EventContext) => ({
  eventId: ctx.eventId(),
  aggregateId,
  correlationId: ctx.correlationId,
  causationId: ctx.causationId,
  occurredAt: ctx.now(),
});

export interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  status: string;
  money: MoneyProps;
  balanceAfter?: MoneyProps;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: string;
}

const transactionData = (t: WagerTransaction): WagerTransactionEventData => ({
  transactionId: t.id,
  providerId: t.providerId,
  externalTransactionId: t.externalTransactionId,
  walletId: t.walletId,
  kind: t.kind,
  status: t.status,
  money: t.money.toJSON(),
  balanceAfter: t.balanceAfter?.toJSON(),
  referenceExternalTransactionId: t.referenceExternalTransactionId,
  referenceTransactionId: t.referenceTransactionId,
  failureCode: t.failureCode,
});

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(t: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({ ...envelope(t.walletId, ctx), data: transactionData(t) });
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(t: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({ ...envelope(t.walletId, ctx), data: transactionData(t) });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(t: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({ ...envelope(t.walletId, ctx), data: transactionData(t) });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...envelope(wallet.id, ctx),
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}