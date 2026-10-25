import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  DeleteMessageBatchCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { AppModule } from '../../src/app.module';
import { SQS_CLIENT } from '../../src/infrastructure/sqs';
import { OutboxRelay } from '../../src/messaging/outbox-relay';
import { OpenWalletUseCase } from '../../src/application/open-wallet';
import { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction';
import { inTransaction } from '../../src/infrastructure/persistence/in-transaction';

let app: INestApplication;
let relay: OutboxRelay;
let em: EntityManager;
let sqs: SQSClient;
let auditUrl: string;

beforeAll(async () => {
  process.env.WORKERS_ENABLED = 'false';
  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
  relay = app.get(OutboxRelay);
  em = app.get(EntityManager);
  sqs = app.get(SQS_CLIENT);
  auditUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: 'wallet-events-audit' }))).QueueUrl!;

  // publica o que sobrou de testes anteriores e limpa a fila de auditoria
  while ((await relay.publishBatch(200)).length > 0) {}
  await sqs.send(new PurgeQueueCommand({ QueueUrl: auditUrl }));
});

afterAll(async () => {
  await app.close();
});

async function processBets(count: number): Promise<string[]> {
  const playerId = `player-${crypto.randomUUID()}`;
  const wallet = await inTransaction(em, (tx) =>
    app.get(OpenWalletUseCase).execute(
      { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } },
      tx,
      { correlationId: 't' },
    ),
  );
  for (let i = 0; i < count; i++) {
    const ext = crypto.randomUUID();
    await inTransaction(em, (tx) =>
      app.get(ProcessWagerTransactionUseCase).execute(
        {
          providerId: 'provider-a',
          externalTransactionId: ext,
          idempotencyKey: `provider-a:${ext}`,
          playerId,
          walletId: wallet.id,
          roundId: 'r',
          gameId: 'g',
          kind: 'BET',
          money: { amount: '1.00', currency: 'BRL' },
        },
        tx,
        { correlationId: 't' },
      ),
    );
  }
  const rows = (await em.getConnection().execute(
    `SELECT id FROM outbox_message WHERE aggregate_id = ? AND published_at IS NULL`,
    [wallet.id],
  )) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

async function receivedEventIds(): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < 10; i++) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: auditUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
    );
    if (Messages.length === 0) break;
    for (const m of Messages) ids.push(JSON.parse(m.Body ?? '{}').eventId);
    await sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: auditUrl,
        Entries: Messages.map((m, n) => ({ Id: String(n), ReceiptHandle: m.ReceiptHandle })),
      }),
    );
  }
  return ids;
}

async function unpublished(ids: string[]): Promise<number> {
  const [row] = (await em.getConnection().execute(
    `SELECT COUNT(*)::int AS n FROM outbox_message WHERE id IN (?) AND published_at IS NULL`,
    [ids],
  )) as unknown as { n: number }[];
  return row?.n ?? 0;
}

/** Publica até não sobrar nenhum dos ids, esperando os retries vencerem. */
async function publishUntilDone(ids: string[], timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((await unpublished(ids)) > 0 && Date.now() < deadline) {
    const published = await relay.publishBatch(50);
    if (published.length === 0) await Bun.sleep(500);
  }
}

describe('transactional outbox', () => {
  it('publishes pending events to SNS and marks them', async () => {
    const ids = await processBets(1); // abertura (2 eventos) + BET (2 eventos)
    expect(ids).toHaveLength(4);

    await publishUntilDone(ids);

    expect(await unpublished(ids)).toBe(0);
    const received = await receivedEventIds();
    for (const id of ids) expect(received).toContain(id);
  });

  it('another instance takes over after a relay dies before publishing', async () => {
    const ids = await processBets(1);
    let releaseCrash!: () => void;
    const crashGate = new Promise<void>((resolve) => (releaseCrash = resolve));
    let locked!: () => void;
    const lockedGate = new Promise<void>((resolve) => (locked = resolve));

    // instância A: trava as linhas e "morre" antes de publicar
    const instanceA = em
      .fork()
      .transactional(async (tx) => {
        await tx.execute(`SELECT id FROM outbox_message WHERE id IN (?) FOR UPDATE`, [ids]);
        locked();
        await crashGate;
        throw new Error('simulated crash');
      })
      .catch(() => undefined);

    await lockedGate;
    // instância B, enquanto A segura o lock: pula as linhas travadas
    const whileLocked = await relay.publishBatch();
    expect(whileLocked.filter((id) => ids.includes(id))).toHaveLength(0);
    expect(await unpublished(ids)).toBe(ids.length);

    releaseCrash();
    await instanceA; // rollback: locks liberados, nada foi marcado

    // instância B assume e publica
    await publishUntilDone(ids);
    expect(await unpublished(ids)).toBe(0);
  });

  it('two concurrent publishers never skip an event', async () => {
    const ids = await processBets(10); // 22 eventos

    const [a, b] = await Promise.all([relay.publishBatch(15), relay.publishBatch(15)]);
    await publishUntilDone(ids);

    expect(await unpublished(ids)).toBe(0);
    // SKIP LOCKED: os dois publishers pegaram lotes disjuntos
    expect(a.filter((id) => b.includes(id))).toHaveLength(0);
    const received = await receivedEventIds();
    for (const id of ids) expect(received).toContain(id);
  });
});