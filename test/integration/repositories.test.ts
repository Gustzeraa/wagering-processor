import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/mikro-orm.config';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { WalletRepository } from '../../src/infrastructure/persistence/repositories';

let orm: MikroORM;
const wallets = new WalletRepository();

beforeAll(async () => {
  orm = await MikroORM.init({ ...config, debug: false });
});

afterAll(async () => {
  await orm.close();
});

describe('WalletRepository', () => {
  it('persists and rehydrates a wallet with exact money', async () => {
    const id = Bun.randomUUIDv7();
    const at = new Date();
    const wallet = Wallet.rehydrate({
      id,
      playerId: `player-${id}`,
      currency: 'BRL',
      balance: Money.from({ amount: '1234567.89', currency: 'BRL' }),
      version: 1,
      createdAt: at,
      updatedAt: at,
    });

    await orm.em.fork().transactional(async (tx) => {
      wallets.add(tx, wallet);
    });

    const loaded = await orm.em.fork().transactional((tx) => wallets.findByIdForUpdate(tx, id));

    expect(loaded?.balance.toString()).toBe('1234567.89');
    expect(loaded?.version).toBe(1);
    expect(loaded?.playerId).toBe(`player-${id}`);
  });
});