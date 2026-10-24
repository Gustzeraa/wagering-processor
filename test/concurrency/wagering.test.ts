import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/mikro-orm.config';
import {
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from '../../src/infrastructure/persistence/repositories';
import { inTransaction } from '../../src/infrastructure/persistence/in-transaction';
import { systemClock, uuidV7 } from '../../src/infrastructure/system';
import { pendingReferencePolicy } from '../../src/application/pending-reference-policy';
import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerCommand,
} from '../../src/application/process-wager-transaction';
import { OpenWalletUseCase } from '../../src/application/open-wallet';
import { LedgerEntryRecord, WagerTransactionRecord } from '../../src/infrastructure/persistence/records';

let orm: MikroORM;
let process: ProcessWagerTransactionUseCase;
let openWallet: OpenWalletUseCase;
const ctx = { correlationId: 'test' };

beforeAll(async () => {
  orm = await MikroORM.init({ ...config, debug: false, pool: { min: 0, max: 60 } });
  const repos = [
    new WalletRepository(),
    new WagerTransactionRepository(),
    new LedgerRepository(),
    new OutboxRepository(),
  ] as const;
  process = new ProcessWagerTransactionUseCase(...repos, systemClock, uuidV7, pendingReferencePolicy());
  openWallet = new OpenWalletUseCase(...repos, systemClock, uuidV7);
});

afterAll(async () => {
  await orm.close();
});

// Invariante de todos os testes: saldo da wallet == saldo reconstruído pelo ledger
afterEach(async () => {
  const mismatches = await orm.em.getConnection().execute(`
    SELECT w.id
    FROM wallet w
    LEFT JOIN wallet_ledger_entry e ON e.wallet_id = w.id
    GROUP BY w.id, w.balance
    HAVING w.balance <> COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END), 0)
  `);
  expect(mismatches).toEqual([]);
});

async function newWallet(amount: string) {
  const playerId = `player-${uuidV7.next()}`;
  const wallet = await inTransaction(orm.em, (tx) =>
    openWallet.execute({ playerId, initialBalance: { amount, currency: 'BRL' } }, tx, ctx),
  );
  return { walletId: wallet.id, playerId };
}

function bet(w: { walletId: string; playerId: string }, externalId: string, amount: string): ProcessWagerCommand {
  return {
    providerId: 'provider-a',
    externalTransactionId: externalId,
    idempotencyKey: `provider-a:${externalId}`,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: `round-${externalId}`,
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

const run = (cmd: ProcessWagerCommand) => inTransaction(orm.em, (tx) => process.execute(cmd, tx, ctx));

async function balanceOf(walletId: string): Promise<string> {
  const [row] = await orm.em.getConnection().execute(
    `SELECT balance::text AS balance FROM wallet WHERE id = ?`, [walletId],
  );
  return row.balance;
}

describe('concurrency', () => {
  it('section 8: two concurrent 80.00 bets on a 100.00 balance', async () => {
    const w = await newWallet('100.00');
    const prefix = uuidV7.next();
    const cmds = [bet(w, `${prefix}-1`, '80.00'), bet(w, `${prefix}-2`, '80.00')];

    await Promise.all(cmds.map(run));

    const em = orm.em.fork();
    const txs = await em.find(WagerTransactionRecord, { walletId: w.walletId, kind: 'BET' });
    expect(txs.filter((t) => t.status === 'PROCESSED')).toHaveLength(1);
    const rejected = txs.filter((t) => t.status === 'REJECTED');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await balanceOf(w.walletId)).toBe('2000');
    expect(await em.count(LedgerEntryRecord, { walletId: w.walletId, direction: 'DEBIT' })).toBe(1);

    // retries não duplicam o débito
    const replays = await Promise.all(cmds.map(run));
    expect(replays.every((r) => r.replay)).toBe(true);
    expect(await balanceOf(w.walletId)).toBe('2000');
    expect(await orm.em.fork().count(LedgerEntryRecord, { walletId: w.walletId, direction: 'DEBIT' })).toBe(1);
  });

  it('the same bet sent 50 times in parallel debits once', async () => {
    const w = await newWallet('100.00');
    const cmd = bet(w, uuidV7.next(), '10.00');

    const results = await Promise.all(Array.from({ length: 50 }, () => run(cmd)));

    expect(results.filter((r) => !r.replay)).toHaveLength(1);
    expect(results.filter((r) => r.replay)).toHaveLength(49);
    expect(await balanceOf(w.walletId)).toBe('9000');
    expect(await orm.em.fork().count(LedgerEntryRecord, { walletId: w.walletId, direction: 'DEBIT' })).toBe(1);
  });

  it('distinct wallets are processed in parallel', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => newWallet('50.00')));
    const results = await Promise.all(wallets.map((w) => run(bet(w, uuidV7.next(), '20.00'))));

    expect(results.every((r) => r.transaction.status === 'PROCESSED')).toBe(true);
    for (const w of wallets) {
      expect(await balanceOf(w.walletId)).toBe('3000');
    }
  });
});