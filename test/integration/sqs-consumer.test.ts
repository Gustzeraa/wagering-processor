import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { AppModule } from '../../src/app.module';
import { SQS_CLIENT } from '../../src/infrastructure/sqs';
import { WagerTransactionConsumer } from '../../src/messaging/wager-transaction.consumer';
import { OpenWalletUseCase } from '../../src/application/open-wallet';
import { inTransaction } from '../../src/infrastructure/persistence/in-transaction';
import { LedgerEntryRecord, WagerTransactionRecord } from '../../src/infrastructure/persistence/records';

let app: INestApplication;
let consumer: WagerTransactionConsumer;
let sqs: SQSClient;
let em: EntityManager;
let queueUrl: string;
let dlqUrl: string;

beforeAll(async () => {
  process.env.WORKERS_ENABLED = 'false'; // o teste controla quando consumir
  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
  consumer = app.get(WagerTransactionConsumer);
  sqs = app.get(SQS_CLIENT);
  em = app.get(EntityManager);
  queueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }))).QueueUrl!;
  dlqUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: 'wager-transactions-dlq.fifo' }))).QueueUrl!;
  await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
  await sqs.send(new PurgeQueueCommand({ QueueUrl: dlqUrl }));
});

afterAll(async () => {
  await app.close();
});

async function newWallet(amount: string) {
  const playerId = `player-${crypto.randomUUID()}`;
  const wallet = await inTransaction(em, (tx) =>
    app.get(OpenWalletUseCase).execute({ playerId, initialBalance: { amount, currency: 'BRL' } }, tx, { correlationId: 't' }),
  );
  return { walletId: wallet.id, playerId };
}

function envelope(w: { walletId: string; playerId: string }, amount: string) {
  const ext = crypto.randomUUID();
  return {
    messageId: `msg-${ext}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId: ext,
      idempotencyKey: `provider-a:${ext}`,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    },
  };
}

async function publish(body: string, groupId: string) {
  await sqs.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: body,
    MessageGroupId: groupId,
    MessageDeduplicationId: crypto.randomUUID(),
  }));
}

async function drain() {
  for (let i = 0; i < 5; i++) {
    const outcomes = await consumer.pollOnce();
    if (outcomes.length === 0) return;
  }
}

const debitsOf = (walletId: string) => em.fork().count(LedgerEntryRecord, { walletId, direction: 'DEBIT' });

describe('SQS consumer', () => {
  it('processes a message and acks it', async () => {
    const w = await newWallet('100.00');
    const msg = envelope(w, '25.00');
    await publish(JSON.stringify(msg), w.walletId);

    await drain();

    const tx = await em.fork().findOne(WagerTransactionRecord, { idempotencyKey: msg.data.idempotencyKey });
    expect(tx?.status).toBe('PROCESSED');
    expect(await debitsOf(w.walletId)).toBe(1);
  });

  it('redelivery after commit (crash before ack) does not duplicate effects', async () => {
    const w = await newWallet('100.00');
    const body = JSON.stringify(envelope(w, '10.00'));

    // primeira entrega: commit feito, mas o ack "nunca aconteceu"
    expect(await consumer.processMessage(body)).toBe('processed');
    // a fila reentrega a mesma mensagem
    expect(await consumer.processMessage(body)).toBe('duplicate');

    expect(await debitsOf(w.walletId)).toBe(1);
  });

  it('a republished message (new SQS id, same messageId) is deduplicated by the inbox', async () => {
    const w = await newWallet('100.00');
    const body = JSON.stringify(envelope(w, '10.00'));
    await publish(body, w.walletId);
    await publish(body, w.walletId);

    await drain();

    expect(await debitsOf(w.walletId)).toBe(1);
  });

  it('sends an invalid message straight to the DLQ', async () => {
    await publish('{ not json', 'poison');
    await drain();

    const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: dlqUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 2,
      MessageAttributeNames: ['All'],
    }));
    const poison = Messages.find((m) => m.Body === '{ not json');
    expect(poison).toBeDefined();
    expect(poison?.MessageAttributes?.reason?.StringValue).toBe('INVALID_MESSAGE');
    for (const m of Messages) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: m.ReceiptHandle }));
    }
  });
});