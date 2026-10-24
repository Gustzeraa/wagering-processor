import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

const bigint = () => ({ type: 'string', columnType: 'bigint' }) as const;
const timestamp = () => ({ type: 'datetime', columnType: 'timestamptz' }) as const;

@Entity({ tableName: 'wallet' })
export class WalletRecord {
  @PrimaryKey({ type: 'uuid' }) id!: string;
  @Property({ type: 'text' }) playerId!: string;
  @Property({ type: 'string', columnType: 'char(3)' }) currency!: string;
  @Property(bigint()) balance!: string;
  @Property({ type: 'integer' }) version!: number;
  @Property(timestamp()) createdAt!: Date;
  @Property(timestamp()) updatedAt!: Date;
}

@Entity({ tableName: 'wager_transaction' })
export class WagerTransactionRecord {
  @PrimaryKey({ type: 'uuid' }) id!: string;
  @Property({ type: 'text' }) providerId!: string;
  @Property({ type: 'text' }) externalTransactionId!: string;
  @Property({ type: 'text' }) idempotencyKey!: string;
  @Property({ type: 'string', columnType: 'char(64)' }) payloadHash!: string;
  @Property({ type: 'uuid' }) walletId!: string;
  @Property({ type: 'text' }) playerId!: string;
  @Property({ type: 'text' }) roundId!: string;
  @Property({ type: 'text' }) gameId!: string;
  @Property({ type: 'text' }) kind!: string;
  @Property(bigint()) amount!: string;
  @Property({ type: 'string', columnType: 'char(3)' }) currency!: string;
  @Property({ type: 'text', nullable: true }) referenceExternalTransactionId?: string | null;
  @Property({ type: 'uuid', nullable: true }) referenceTransactionId?: string | null;
  @Property({ type: 'text' }) status!: string;
  @Property({ type: 'text', nullable: true }) failureCode?: string | null;
  @Property({ ...timestamp(), nullable: true }) processedAt?: Date | null;
  @Property({ ...bigint(), nullable: true }) balanceAfter?: string | null;
  @Property({ type: 'integer' }) referenceAttempts!: number;
  @Property({ ...timestamp(), nullable: true }) nextReferenceAttemptAt?: Date | null;
  @Property(timestamp()) createdAt!: Date;
}

@Entity({ tableName: 'wallet_ledger_entry' })
export class LedgerEntryRecord {
  @PrimaryKey({ type: 'uuid' }) id!: string;
  @Property({ type: 'uuid' }) walletId!: string;
  @Property({ type: 'uuid' }) transactionId!: string;
  @Property({ type: 'text' }) direction!: string;
  @Property(bigint()) amount!: string;
  @Property({ type: 'string', columnType: 'char(3)' }) currency!: string;
  @Property(bigint()) balanceBefore!: string;
  @Property(bigint()) balanceAfter!: string;
  @Property({ type: 'integer' }) walletVersion!: number;
  @Property(timestamp()) createdAt!: Date;
}

@Entity({ tableName: 'inbox_message' })
export class InboxMessageRecord {
  @PrimaryKey({ type: 'text' }) consumerName!: string;
  @PrimaryKey({ type: 'text' }) messageId!: string;
  @Property({ type: 'string', columnType: 'char(64)' }) payloadHash!: string;
  @Property(timestamp()) receivedAt!: Date;
  @Property({ ...timestamp(), nullable: true }) processedAt?: Date | null;
}

@Entity({ tableName: 'outbox_message' })
export class OutboxMessageRecord {
  @PrimaryKey({ type: 'uuid' }) id!: string;
  @Property({ type: 'uuid' }) aggregateId!: string;
  @Property({ type: 'text' }) eventType!: string;
  @Property({ type: 'json', columnType: 'jsonb' }) payload!: Record<string, unknown>;
  @Property(timestamp()) occurredAt!: Date;
  @Property({ type: 'integer' }) attempts!: number;
  @Property({ ...timestamp(), nullable: true }) nextAttemptAt?: Date | null;
  @Property({ ...timestamp(), nullable: true }) publishedAt?: Date | null;
}

export const RECORDS = [
  WalletRecord,
  WagerTransactionRecord,
  LedgerEntryRecord,
  InboxMessageRecord,
  OutboxMessageRecord,
];