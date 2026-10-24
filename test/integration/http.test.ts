import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { ApiExceptionFilter } from '../../src/http/api-exception.filter';

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
    process.env.WORKERS_ENABLED = 'false';
  app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(0); // porta livre qualquer
  baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');
});

afterAll(async () => {
  await app.close();
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function createWallet(amount = '100.00') {
  const playerId = `player-${crypto.randomUUID()}`;
  const res = await call('POST', '/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } });
  return { ...res, playerId };
}

function wager(w: { walletId: string; playerId: string }, extId: string, kind: string, amount: string, ref?: string) {
  return {
    providerId: 'provider-a',
    externalTransactionId: extId,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...(ref ? { referenceExternalTransactionId: ref } : {}),
  };
}

const submit = (body: unknown, key?: string) =>
  call('POST', '/wagering/transactions', body, key ? { 'idempotency-key': key } : {});

describe('HTTP API', () => {
  it('creates a wallet and rejects a duplicate', async () => {
    const created = await createWallet('1000.00');
    expect(created.status).toBe(201);
    expect(created.body.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(created.body.version).toBe(1);

    const dup = await call('POST', '/wallets', {
      playerId: created.playerId,
      initialBalance: { amount: '5.00', currency: 'BRL' },
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  it('processes, replays and detects payload conflicts', async () => {
    const created = await createWallet('100.00');
    const w = { walletId: created.body.id, playerId: created.playerId };
    const ext = crypto.randomUUID();
    const body = wager(w, ext, 'BET', '25.00');

    const first = await submit(body, `provider-a:${ext}`);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
    expect(first.body.balance.amount).toBe('75.00');

    const replay = await submit(body, `provider-a:${ext}`);
    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.transactionId).toBe(first.body.transactionId);

    const conflict = await submit({ ...body, money: { amount: '50.00', currency: 'BRL' } }, `provider-a:${ext}`);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('distinguishes invalid payload, business rejection and pending reference', async () => {
    const created = await createWallet('10.00');
    const w = { walletId: created.body.id, playerId: created.playerId };

    const noKey = await submit(wager(w, 'x', 'BET', '1.00'));
    expect(noKey.status).toBe(400);

    const badMoney = await submit(wager(w, 'y', 'BET', '1.5'), 'k-y');
    expect(badMoney.status).toBe(400);

    const opening = await submit(wager(w, 'z', 'OPENING', '1.00'), 'k-z');
    expect(opening.status).toBe(400);

    const ext = crypto.randomUUID();
    const broke = await submit(wager(w, ext, 'BET', '50.00'), `provider-a:${ext}`);
    expect(broke.status).toBe(422);
    expect(broke.body.failureCode).toBe('INSUFFICIENT_FUNDS');

    const missingBet = crypto.randomUUID();
    const rbExt = crypto.randomUUID();
    const pending = await submit(wager(w, rbExt, 'ROLLBACK', '5.00', missingBet), `provider-a:${rbExt}`);
    expect(pending.status).toBe(202);
    expect(pending.body.status).toBe('PENDING_REFERENCE');
  });

  it('refunds a bet once and rejects a second reversal', async () => {
    const created = await createWallet('100.00');
    const w = { walletId: created.body.id, playerId: created.playerId };
    const betExt = crypto.randomUUID();
    await submit(wager(w, betExt, 'BET', '30.00'), `provider-a:${betExt}`);

    const refundExt = crypto.randomUUID();
    const refund = await submit(wager(w, refundExt, 'REFUND', '30.00', betExt), `provider-a:${refundExt}`);
    expect(refund.status).toBe(201);
    expect(refund.body.balance.amount).toBe('100.00');

    const rbExt = crypto.randomUUID();
    const rollback = await submit(wager(w, rbExt, 'ROLLBACK', '30.00', betExt), `provider-a:${rbExt}`);
    expect(rollback.status).toBe(422);
    expect(rollback.body.failureCode).toBe('ALREADY_REVERSED');
  });

  it('serves wallet, ledger pages, lookups and reconciliation', async () => {
    const created = await createWallet('100.00');
    const w = { walletId: created.body.id, playerId: created.playerId };
    for (let i = 0; i < 3; i++) {
      const ext = crypto.randomUUID();
      await submit(wager(w, ext, 'BET', '1.00'), `provider-a:${ext}`);
    }

    const wallet = await call('GET', `/wallets/${w.walletId}`);
    expect(wallet.body.balance.amount).toBe('97.00');
    expect(wallet.body.version).toBe(4);

    const page1 = await call('GET', `/wallets/${w.walletId}/ledger?limit=2`);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).toBeString();
    const page2 = await call('GET', `/wallets/${w.walletId}/ledger?limit=2&cursor=${page1.body.nextCursor}`);
    expect(page2.body.items).toHaveLength(2);
    expect(page2.body.nextCursor).toBeNull();

    const rec = await call('POST', `/wallets/${w.walletId}/reconciliation`);
    expect(rec.status).toBe(200);
    expect(rec.body).toMatchObject({ consistent: true, checkedEntries: 4 });

    expect((await call('GET', '/wallets/not-a-uuid')).status).toBe(400);
    expect((await call('GET', `/wallets/${crypto.randomUUID()}`)).status).toBe(404);
  });

  it('exposes health checks', async () => {
    expect((await call('GET', '/health/live')).status).toBe(200);
    const ready = await call('GET', '/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toEqual({ postgres: 'up', sqs: 'up' });
  });
});