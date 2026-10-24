import { describe, expect, it } from 'bun:test';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/ledger-entry';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidLedgerEntryError,
  InvalidMoneyError,
} from '../../src/domain/errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-10-24T12:00:00.000Z');
let seq = 0;
const ctx = () => ({ transactionId: `tx-${++seq}`, entryId: `entry-${seq}`, at });

const openWallet = (initial: string) =>
  Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: brl(initial), opening: ctx() });

describe('Wallet', () => {
  it('opens with version 1 and an opening credit', () => {
    const { wallet, openingEntry } = openWallet('100.00');
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceAfter.toString()).toBe('100.00');
  });

  it('opens with zero balance and no ledger entry', () => {
    const { wallet, openingEntry } = openWallet('0.00');
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  it('debits and produces a balanced entry', () => {
    const { wallet } = openWallet('100.00');
    const entry = wallet.debit(brl('80.00'), ctx());
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('20.00');
    expect(entry.walletVersion).toBe(2);
    expect(entry.isBalanced()).toBe(true);
  });

  it('credits and increments version', () => {
    const { wallet } = openWallet('10.00');
    wallet.credit(brl('5.50'), ctx());
    expect(wallet.balance.toString()).toBe('15.50');
    expect(wallet.version).toBe(2);
  });

  it('rejects debit beyond balance and keeps state intact', () => {
    const { wallet } = openWallet('100.00');
    wallet.debit(brl('80.00'), ctx());
    expect(() => wallet.debit(brl('80.00'), ctx())).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
  });

  it('rejects zero amounts', () => {
    const { wallet } = openWallet('100.00');
    expect(() => wallet.debit(brl('0.00'), ctx())).toThrow(InvalidMoneyError);
    expect(() => wallet.credit(brl('0.00'), ctx())).toThrow(InvalidMoneyError);
  });

  it('rejects other currencies', () => {
    const { wallet } = openWallet('100.00');
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => wallet.debit(usd, ctx())).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usd, ctx())).toThrow(CurrencyMismatchError);
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e-1', walletId: 'w-1', transactionId: 'tx-1',
    walletVersion: 2, createdAt: at,
  };

  it('rejects unbalanced entries', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base, direction: LedgerDirection.Credit,
        money: brl('10.00'), balanceBefore: brl('0.00'), balanceAfter: brl('20.00'),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejects negative resulting balance', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base, direction: LedgerDirection.Debit,
        money: brl('10.00'), balanceBefore: brl('5.00'),
        balanceAfter: brl('5.00').subtract(brl('10.00')),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });
});