import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Subprocess } from 'bun';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  SendMessageBatchCommand,
} from '@aws-sdk/client-sqs';
import config from '../../src/mikro-orm.config';
import { createSqsClient } from '../../src/infrastructure/sqs';
import {
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from '../../src/infrastructure/persistence/repositories';
import { OpenWalletUseCase } from '../../src/application/open-wallet';
import { inTransaction } from '../../src/infrastructure/persistence/in-transaction';
import { systemClock, uuidV7 } from '../../src/infrastructure/system';

const sqs = createSqsClient();
let orm: MikroORM;
let openWallet: OpenWalletUseCase;
let queueUrl: string;
const running: Subprocess[] = [];

// fila exclusiva desta execução: nenhum outro consumidor a conhece
const TEST_QUEUE_NAME = `wager-transactions-test-${Date.now()}.fifo`;

beforeAll(async () => {
  orm = await MikroORM.init({ ...config, debug: false });
  openWallet = new OpenWalletUseCase(
    new WalletRepository(),
    new WagerTransactionRepository(),
    new LedgerRepository(),
    new OutboxRepository(),
    systemClock,
    uuidV7,
  );
  const created = await sqs.send(
    new CreateQueueCommand({
      QueueName: TEST_QUEUE_NAME,
      Attributes: { FifoQueue: 'true', VisibilityTimeout: '30' },
    }),
  );
  queueUrl = created.QueueUrl!;
});

afterEach(async () => {
  await stopAll();
  // Invariante final: saldo da wallet == saldo reconstruído pelo ledger
  const mismatches = await orm.em.getConnection().execute(`
    SELECT w.id FROM wallet w
    LEFT JOIN wallet_ledger_entry e ON e.wallet_id = w.id
    GROUP BY w.id, w.balance
    HAVING w.balance <> COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END), 0)
  `);
  expect(mismatches).toEqual([]);
});

afterAll(async () => {
  await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl })).catch(() => undefined);
  await orm.close();
});

// ---------- processos ----------

function spawnInstance(port: number, env: Record<string, string> = {}, showLogs = false): Subprocess {
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      WORKERS_ENABLED: 'true',
      WAGER_QUEUE_NAME: TEST_QUEUE_NAME,
      ...env,
    },
    stdout: showLogs ? 'inherit' : 'ignore',
    stderr: 'inherit',
  });
  running.push(proc);
  return proc;
}

async function stopAll(signal?: number): Promise<void> {
  for (const proc of running.splice(0)) {
    proc.kill(signal);
    await proc.exited;
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const waitReady = (port: number) =>
  waitFor(
    async () => {
      try {
        return (await fetch(`http://localhost:${port}/health/ready`)).ok;
      } catch {
        return false;
      }
    },
    30_000,
    `instance on port ${port}`,
  );

// ---------- dados ----------

async function newWallet(amount: string) {
  const playerId = `player-${uuidV7.next()}`;
  const wallet = await inTransaction(orm.em, (tx) =>
    openWallet.execute({ playerId, initialBalance: { amount, currency: 'BRL' } }, tx, { correlationId: 'test' }),
  );
  return { walletId: wallet.id, playerId };
}

interface Outgoing {
  body: string;
  groupId: string;
}

function bets(w: { walletId: string; playerId: string }, prefix: string, count: number, amount: string): Outgoing[] {
  return Array.from({ length: count }, (_, i) => {
    const ext = `${prefix}-${i}`;
    return {
      groupId: w.walletId,
      body: JSON.stringify({
        messageId: `msg-${ext}`,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          providerId: 'provider-a',
          externalTransactionId: ext,
          idempotencyKey: `provider-a:${ext}`,
          playerId: w.playerId,
          walletId: w.walletId,
          roundId: `round-${ext}`,
          gameId: 'fortune-chimp',
          kind: 'BET',
          money: { amount, currency: 'BRL' },
        },
      }),
    };
  });
}

async function publish(messages: Outgoing[]): Promise<void> {
  for (let i = 0; i < messages.length; i += 10) {
    await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: messages.slice(i, i + 10).map((m, n) => ({
          Id: String(n),
          MessageBody: m.body,
          MessageGroupId: m.groupId,
          MessageDeduplicationId: crypto.randomUUID(),
        })),
      }),
    );
  }
}

async function terminalCount(prefix: string): Promise<number> {
  const [row] = (await orm.em.getConnection().execute(
    `SELECT COUNT(*)::int AS n FROM wager_transaction
     WHERE external_transaction_id LIKE ? AND status IN ('PROCESSED', 'REJECTED')`,
    [`${prefix}%`],
  )) as unknown as { n: number }[];
  return row?.n ?? 0;
}

async function queueDrained(): Promise<boolean> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return (
    Number(Attributes?.ApproximateNumberOfMessages) === 0 &&
    Number(Attributes?.ApproximateNumberOfMessagesNotVisible) === 0
  );
}

async function balanceOf(walletId: string): Promise<string | undefined> {
  const [row] = (await orm.em.getConnection().execute(
    `SELECT balance::text AS balance FROM wallet WHERE id = ?`,
    [walletId],
  )) as unknown as { balance: string }[];
  return row?.balance;
}

async function debits(walletId: string): Promise<number> {
  const [row] = (await orm.em.getConnection().execute(
    `SELECT COUNT(*)::int AS n FROM wallet_ledger_entry WHERE wallet_id = ? AND direction = 'DEBIT'`,
    [walletId],
  )) as unknown as { n: number }[];
  return row?.n ?? 0;
}

// ---------- testes ----------

describe('multiple processes', () => {
  it('three instances consume the same queue without duplicating effects', async () => {
    const prefix = `p4-${uuidV7.next()}`;
    const wallets = await Promise.all(Array.from({ length: 5 }, () => newWallet('100.00')));
    const messages = wallets.flatMap((w, i) => bets(w, `${prefix}-${i}`, 20, '1.00'));

    const ports = [4001, 4002, 4003];
    ports.forEach((port) => spawnInstance(port));
    await Promise.all(ports.map(waitReady));

    // cada mensagem é publicada duas vezes: a inbox tem que barrar a cópia
    await publish([...messages, ...messages]);

    await waitFor(
      async () => (await terminalCount(prefix)) === 100 && (await queueDrained()),
      90_000,
      'all messages processed',
    );
    for (const w of wallets) {
      expect(await balanceOf(w.walletId)).toBe('8000');
      expect(await debits(w.walletId)).toBe(20);
    }
  }, 120_000);

  it('a worker killed after commit and before ack does not duplicate the debit', async () => {
    const prefix = `p5-${uuidV7.next()}`;
    const w = await newWallet('100.00');

    const crasher = spawnInstance(4011, { CRASH_AFTER_COMMIT: 'true' });
    await waitReady(4011);
    await publish(bets(w, prefix, 1, '10.00'));

    const exitCode = await Promise.race([crasher.exited, Bun.sleep(60_000).then(() => 'timeout' as const)]);
    if (exitCode === 'timeout') {
      const { Attributes } = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        }),
      );
      console.log('DIAGNOSTIC queue:', Attributes, 'terminal transactions:', await terminalCount(prefix));
    }
    expect(exitCode).toBe(1);
    running.splice(running.indexOf(crasher), 1);

    expect(await terminalCount(prefix)).toBe(1); // o commit aconteceu
    expect(await queueDrained()).toBe(false); // mas a mensagem não foi confirmada

    // outra instância recebe a reentrega depois do visibility timeout
    spawnInstance(4012);
    await waitReady(4012);
    await waitFor(queueDrained, 90_000, 'redelivered message to be acked');

    expect(await debits(w.walletId)).toBe(1);
    expect(await balanceOf(w.walletId)).toBe('9000');
  }, 150_000);

  it('instances killed mid-stream and restarted reach a consistent final state', async () => {
    const prefix = `p8-${uuidV7.next()}`;
    const wallets = await Promise.all(Array.from({ length: 5 }, () => newWallet('100.00')));
    const messages = wallets.flatMap((w, i) => bets(w, `${prefix}-${i}`, 30, '1.00'));

    const firstRun = [4021, 4022, 4023];
    firstRun.forEach((port) => spawnInstance(port));
    await Promise.all(firstRun.map(waitReady));
    await publish(messages);

    // derruba tudo de forma abrupta no meio do processamento
    await Bun.sleep(500);
    await stopAll(9);

    const secondRun = [4031, 4032, 4033];
    secondRun.forEach((port) => spawnInstance(port));
    await Promise.all(secondRun.map(waitReady));

    await waitFor(
      async () => (await terminalCount(prefix)) === 150 && (await queueDrained()),
      100_000,
      'all messages processed after restart',
    );
    for (const w of wallets) {
      expect(await balanceOf(w.walletId)).toBe('7000');
      expect(await debits(w.walletId)).toBe(30);
    }
  }, 150_000);
});