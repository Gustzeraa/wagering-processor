import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { ProcessWagerTransactionUseCase } from '../application/process-wager-transaction';
import { pendingReferencePolicy } from '../application/pending-reference-policy';
import {
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from '../infrastructure/persistence/repositories';
import { inTransaction } from '../infrastructure/persistence/in-transaction';
import { systemClock } from '../infrastructure/system';
import { evaluateReference } from '../domain/reference-policy';
import { FailureCode } from '../domain/failure-code';
import { WagerTransactionStatus as Status } from '../domain/wager-transaction';
import type { WalletLedgerEntry } from '../domain/ledger-entry';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type PendingOutcome = 'processed' | 'rejected' | 'rescheduled' | 'skipped';

@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('PendingReferenceWorker');
  private readonly policy = pendingReferencePolicy();
  private running = false;
  private loop?: Promise<void>;

  constructor(
    private readonly em: EntityManager,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly ledger: LedgerRepository,
    private readonly outbox: OutboxRepository,
    private readonly processWager: ProcessWagerTransactionUseCase,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.WORKERS_ENABLED === 'false') return;
    this.running = true;
    this.loop = this.run();
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    await this.loop?.catch(() => undefined);
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const outcomes = await this.processDue();
        if (outcomes.length === 0) await sleep(1_000);
      } catch (error) {
        this.logger.error({ msg: 'pending reference worker failed', error: String(error) });
        await sleep(1_000);
      }
    }
  }

  /** asOf permite aos testes simular a passagem do tempo sem esperar de verdade. */
  async processDue(asOf: Date = systemClock.now(), limit = 20): Promise<PendingOutcome[]> {
    const due = (await this.em.fork().getConnection().execute(
      `SELECT id, wallet_id FROM wager_transaction
       WHERE status = 'PENDING_REFERENCE' AND next_reference_attempt_at <= ?
       ORDER BY next_reference_attempt_at
       LIMIT ?`,
      [asOf, limit],
    )) as unknown as { id: string; wallet_id: string }[];

    const outcomes: PendingOutcome[] = [];
    for (const row of due) {
      outcomes.push(await this.resolve(row.id, row.wallet_id, asOf));
    }
    return outcomes;
  }

  /** Uma pendente por transação, com a wallet travada. */
  private resolve(transactionId: string, walletId: string, now: Date): Promise<PendingOutcome> {
    return inTransaction(this.em, async (tx) => {
      await tx.execute(`SET LOCAL lock_timeout = '5s'`);
      const wallet = await this.wallets.findByIdForUpdate(tx, walletId);
      const t = await this.transactions.findById(tx, transactionId);

      // outra instância pode ter resolvido enquanto esperávamos o lock
      if (!wallet || !t || t.status !== Status.PendingReference || !t.referenceExternalTransactionId) {
        return 'skipped';
      }

      const reference = await this.transactions.findByProviderExternalId(
        tx, t.providerId, t.referenceExternalTransactionId,
      );
      const reversed = reference && t.requiresReference()
        ? await this.transactions.hasProcessedReversal(tx, reference.id)
        : false;
      const decision = evaluateReference(t, reference, reversed);

      let entry: WalletLedgerEntry | undefined;
      if (decision.outcome === 'wait') {
        if (this.policy.isExpired(t.createdAt, now)) {
          t.reject(FailureCode.ReferenceNotFound, wallet.balance);
        } else {
          t.scheduleReferenceRetry(this.policy.nextAttempt(now, t.referenceAttempts + 1));
        }
      } else if (decision.outcome === 'reject') {
        t.reject(decision.code, wallet.balance);
      } else {
        entry = this.processWager.apply(t, wallet, decision.reference, now);
      }

      await this.transactions.update(tx, t);
      if (entry) {
        this.ledger.add(tx, entry);
        await this.wallets.update(tx, wallet);
      }
      if (t.isTerminal()) {
        const ctx = { correlationId: t.idempotencyKey, causationId: 'pending-reference-worker' };
        for (const event of this.processWager.eventsFor(t, wallet, entry, ctx)) {
          this.outbox.add(tx, event);
        }
      }

      const finalStatus = t.status as Status;
      if (finalStatus === Status.Processed) return 'processed';
      if (finalStatus === Status.Rejected) return 'rejected';
      return 'rescheduled';
    });
  }
}