import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/postgresql';
import config from './mikro-orm.config';
import {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from './infrastructure/persistence/repositories';
import { systemClock, uuidV7 } from './infrastructure/system';
import { createSqsClient, SQS_CLIENT } from './infrastructure/sqs';
import { createSnsClient, SNS_CLIENT } from './infrastructure/sns';
import { pendingReferencePolicy } from './application/pending-reference-policy';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction';
import { OpenWalletUseCase } from './application/open-wallet';
import { ReconcileWalletUseCase } from './application/reconcile-wallet';
import { WalletsController } from './http/wallets.controller';
import { WageringController } from './http/wagering.controller';
import { HealthController } from './http/health.controller';
import { AuthGuard } from './http/auth.guard';
import { WagerTransactionConsumer } from './messaging/wager-transaction.consumer';
import { OutboxRelay } from './messaging/outbox-relay';
import { PendingReferenceWorker } from './messaging/pending-reference.worker';

const REPOSITORIES = [WalletRepository, WagerTransactionRepository, LedgerRepository, OutboxRepository];

@Module({
  imports: [MikroOrmModule.forRoot(config)],
  controllers: [WalletsController, WageringController, HealthController],
  providers: [
    ...REPOSITORIES,
    InboxRepository,
    AuthGuard,
    { provide: SQS_CLIENT, useFactory: createSqsClient },
    { provide: SNS_CLIENT, useFactory: createSnsClient },
    {
      provide: ProcessWagerTransactionUseCase,
      inject: REPOSITORIES,
      useFactory: (w: WalletRepository, t: WagerTransactionRepository, l: LedgerRepository, o: OutboxRepository) =>
        new ProcessWagerTransactionUseCase(w, t, l, o, systemClock, uuidV7, pendingReferencePolicy()),
    },
    {
      provide: OpenWalletUseCase,
      inject: REPOSITORIES,
      useFactory: (w: WalletRepository, t: WagerTransactionRepository, l: LedgerRepository, o: OutboxRepository) =>
        new OpenWalletUseCase(w, t, l, o, systemClock, uuidV7),
    },
    {
      provide: ReconcileWalletUseCase,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => new ReconcileWalletUseCase(em),
    },
    WagerTransactionConsumer,
    OutboxRelay,
    PendingReferenceWorker,
  ],
})
export class AppModule {}