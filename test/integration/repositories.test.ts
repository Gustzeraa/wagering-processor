import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
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
import { OpenWalletUseCase } from '../../src/application/open-wallet';

let orm: MikroORM;
const wallets = new WalletRepository();
const ledger = new LedgerRepository();
const openWallet = new OpenWalletUseCase(
  wallets, new WagerTransactionRepository(), ledger, new OutboxRepository(), systemClock, uuidV7,
);

beforeAll(async () => {
  orm = await MikroORM.init({ ...config, debug: false });
});

afterAll(async () => {
  await orm.close();
});

describe('wallet persistence', () => {
  it('opens a wallet with an opening entry and rehydrates exact money', async () => {
    const playerId = `player-${uuidV7.next()}`;
    const created = await inTransaction(orm.em, (tx) =>
      openWallet.execute(
        { playerId, initialBalance: { amount: '1234567.89', currency: 'BRL' } },
        tx,
        { correlationId: 'test' },
      ),
    );

    const loaded = await inTransaction(orm.em, (tx) => wallets.findByIdForUpdate(tx, created.id));
    expect(loaded?.balance.toString()).toBe('1234567.89');
    expect(loaded?.version).toBe(1);

    const entries = await inTransaction(orm.em, (tx) => ledger.listByWallet(tx, created.id));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.balanceAfter.toString()).toBe('1234567.89');
  });
});