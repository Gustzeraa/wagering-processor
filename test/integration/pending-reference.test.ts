import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { AppModule } from '../../src/app.module';
import { OpenWalletUseCase } from '../../src/application/open-wallet';
import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerCommand,
} from '../../src/application/process-wager-transaction';
import { PendingReferenceWorker } from '../../src/messaging/pending-reference.worker';
import { inTransaction } from '../../src/infrastructure/persistence/in-transaction';
import { LedgerEntryRecord, WagerTransactionRecord } from '../../src/infrastructure/persistence/records';
import { WagerTransactionStatus } from '../../src/domain/wager-transaction';

let app: INestApplication;
let em: EntityManager;
let worker: PendingReferenceWorker;

beforeAll(async () => {
  process.env.WORKERS_ENABLED = 'false';
  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
  em = app.get(EntityManager);
  worker = app.get(PendingReferenceWorker);
});

afterAll(async () => {
  await app.close();
});

const inSeconds = (s: number) => new Date(Date.now() + s * 1000);

async function newWallet(amount: string) {
  const playerId = `player-${crypto.randomUUID()}`;
  const wallet = await inTransaction(em, (tx) =>
    app.get(OpenWalletUseCase).execute({ playerId, initialBalance: { amount, currency: 'BRL' } }, tx, { correlationId: 't' }),
  );
  return { walletId: wallet.id, playerId };
}

function command(w: { walletId: string; playerId: string }, kind: string, amount: string, ref?: string): ProcessWagerCommand {
  const ext = crypto.randomUUID();
  return {
    providerId: 'provider-a',
    externalTransactionId: ext,
    idempotencyKey: `provider-a:${ext}`,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: 'round-1',
    gameId: 'g',
    kind,
    money: { amount, currency: 'BRL' },
    referenceExternalTransactionId: ref,
  };
}

const submit = (cmd: ProcessWagerCommand) =>
  inTransaction(em, (tx) => app.get(ProcessWagerTransactionUseCase).execute(cmd, tx, { correlationId: 't' }));

const statusOf = async (key: string) =>
  (await em.fork().findOne(WagerTransactionRecord, { idempotencyKey: key }))?.status;

const balanceOf = async (walletId: string) => {
  const [row] = (await em.getConnection().execute(
    `SELECT balance::text AS balance FROM wallet WHERE id = ?`, [walletId],
  )) as unknown as { balance: string }[];
  return row?.balance;
};

describe('pending reference worker', () => {
  it('ROLLBACK delivered before its BET is applied once the BET arrives', async () => {
    const w = await newWallet('100.00');
    const betCmd = command(w, 'BET', '10.00');
    const rollbackCmd = command(w, 'ROLLBACK', '10.00', betCmd.externalTransactionId);

    const early = await submit(rollbackCmd);
    expect(early.transaction.status).toBe(WagerTransactionStatus.PendingReference);

    await submit(betCmd);
    expect(await balanceOf(w.walletId)).toBe('9000');

    await worker.processDue(inSeconds(5));

    expect(await statusOf(rollbackCmd.idempotencyKey)).toBe('PROCESSED');
    expect(await balanceOf(w.walletId)).toBe('10000');
    expect(await em.fork().count(LedgerEntryRecord, { walletId: w.walletId })).toBe(3); // abertura, débito, estorno
  });

  it('REFUND delivered before its BET is applied once the BET arrives', async () => {
    const w = await newWallet('50.00');
    const betCmd = command(w, 'BET', '20.00');
    const refundCmd = command(w, 'REFUND', '20.00', betCmd.externalTransactionId);

    await submit(refundCmd);
    await submit(betCmd);
    await worker.processDue(inSeconds(5));

    expect(await statusOf(refundCmd.idempotencyKey)).toBe('PROCESSED');
    expect(await balanceOf(w.walletId)).toBe('5000');
  });

  it('reschedules while the reference is still missing', async () => {
    const w = await newWallet('10.00');
    const cmd = command(w, 'ROLLBACK', '1.00', crypto.randomUUID());
    await submit(cmd);

    await worker.processDue(inSeconds(5));

    const record = await em.fork().findOne(WagerTransactionRecord, { idempotencyKey: cmd.idempotencyKey });
    expect(record?.status).toBe('PENDING_REFERENCE');
    expect(record?.referenceAttempts).toBe(1);
  });

  it('rejects with REFERENCE_NOT_FOUND after the TTL and publishes the event', async () => {
    const w = await newWallet('10.00');
    const cmd = command(w, 'ROLLBACK', '1.00', crypto.randomUUID());
    const { transaction } = await submit(cmd);

    await worker.processDue(inSeconds(60 * 60)); // uma hora depois: TTL de 30 min estourado

    const record = await em.fork().findOne(WagerTransactionRecord, { idempotencyKey: cmd.idempotencyKey });
    expect(record?.status).toBe('REJECTED');
    expect(record?.failureCode).toBe('REFERENCE_NOT_FOUND');

    const events = (await em.getConnection().execute(
      `SELECT event_type FROM outbox_message WHERE payload->'data'->>'transactionId' = ?`, [transaction.id],
    )) as unknown as { event_type: string }[];
    expect(events.map((e) => e.event_type)).toContain('WagerTransactionRejected');
  });
});