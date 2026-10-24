import type { EntityManager } from '@mikro-orm/postgresql';
import type { Clock, IdGenerator } from './ports';
import type { RequestContext } from './process-wager-transaction';
import { Money, type MoneyProps } from '../domain/money';
import { Wallet } from '../domain/wallet';
import { computePayloadHash } from '../domain/payload-hash';
import { WagerTransaction, WagerTransactionKind } from '../domain/wager-transaction';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../domain/events';
import type {
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from '../infrastructure/persistence/repositories';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export class OpenWalletUseCase {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly ledger: LedgerRepository,
    private readonly outbox: OutboxRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(cmd: OpenWalletCommand, tx: EntityManager, ctx: RequestContext): Promise<Wallet> {
    const initialBalance = Money.from(cmd.initialBalance);
    const now = this.clock.now();
    const walletId = this.ids.next();
    const openingTxId = this.ids.next();

    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: cmd.playerId,
      initialBalance,
      opening: { transactionId: openingTxId, entryId: this.ids.next(), at: now },
    });
    this.wallets.add(tx, wallet);

    if (openingEntry) {
      const fields = {
        providerId: 'internal',
        externalTransactionId: `opening:${walletId}`,
        playerId: cmd.playerId,
        walletId,
        roundId: 'opening',
        gameId: 'internal',
        kind: WagerTransactionKind.Opening,
        money: initialBalance.toJSON(),
      };
      const opening = WagerTransaction.create({
        ...fields,
        id: openingTxId,
        idempotencyKey: `internal:opening:${walletId}`,
        payloadHash: computePayloadHash(fields),
        money: initialBalance,
        createdAt: now,
      });
      opening.markProcessed(undefined, wallet.balance, now);

      this.transactions.add(tx, opening);
      this.ledger.add(tx, openingEntry);

      const eventCtx = {
        correlationId: ctx.correlationId,
        causationId: ctx.causationId,
        eventId: () => this.ids.next(),
        now: () => this.clock.now(),
      };
      this.outbox.add(tx, WagerTransactionProcessed.from(opening, eventCtx));
      this.outbox.add(tx, WalletBalanceChanged.from(wallet, openingEntry, eventCtx));
    }

    return wallet;
  }
}