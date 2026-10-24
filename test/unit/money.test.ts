import { describe, expect, it } from 'bun:test';
import { Money } from '../../src/domain/money';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  it('round-trips a valid amount', () => {
    expect(brl('25.00').toString()).toBe('25.00');
    expect(brl('0.07').toMinorUnits()).toBe(7n);
  });

  it('adds without floating point errors', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
  });

  it('rejects a third decimal place instead of rounding', () => {
    expect(() => brl('25.005')).toThrow(InvalidMoneyError);
  });

  it.each(['', 'abc', 'NaN', 'Infinity', '1e5', '-5.00', '25', '25.5', '007.00', ' 25.00'])(
    'rejects invalid amount %p',
    (amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    },
  );

  it('rejects a number instead of a string', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
  });

  it.each(['brl', 'BR', 'BRLL', ''])('rejects invalid currency %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  it('throws on currency mismatch', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl('1.00').equals(usd)).toBe(false);
  });

  it('supports negative results internally', () => {
    const result = brl('10.00').subtract(brl('35.00'));
    expect(result.isNegative()).toBe(true);
    expect(result.toString()).toBe('-25.00');
    expect(brl('25.00').negate().toString()).toBe('-25.00');
  });

  it('is immutable', () => {
    const a = brl('10.00');
    a.add(brl('5.00'));
    expect(a.toString()).toBe('10.00');
  });

  it('serializes to the contract format', () => {
    expect(JSON.stringify({ money: brl('25.00') })).toBe(
      '{"money":{"amount":"25.00","currency":"BRL"}}',
    );
  });

  it('compares values', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('1.00').isLessThan(brl('2.00'))).toBe(true);
    expect(brl('1.00').equals(brl('1.00'))).toBe(true);
  });
});