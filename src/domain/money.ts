import { CurrencyMismatchError, InvalidMoneyError } from './errors';

const AMOUNT_PATTERN = /^(0|[1-9]\d*)\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {}

  /** Entrada externa (API, fila): formato estrito, nunca negativo. */
  static from(props: MoneyProps): Money {
    if (typeof props.amount !== 'string' || !AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(`Invalid amount: ${String(props.amount)}`);
    }
    Money.assertValidCurrency(props.currency);
    const [integer, fraction] = props.amount.split('.') as [string, string];
    return new Money(BigInt(integer) * 100n + BigInt(fraction), props.currency);
  }

  /** Persistência: valor exato já gravado, em centavos. */
  static fromMinorUnits(minor: bigint, currency: string): Money {
    Money.assertValidCurrency(currency);
    return new Money(minor, currency);
  }

  static zero(currency: string): Money {
    return Money.fromMinorUnits(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  toMinorUnits(): bigint {
    return this.minor;
  }

  toString(): string {
    const sign = this.minor < 0n ? '-' : '';
    const abs = this.minor < 0n ? -this.minor : this.minor;
    const fraction = (abs % 100n).toString().padStart(2, '0');
    return `${sign}${abs / 100n}.${fraction}`;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertValidCurrency(currency: string): void {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency: ${String(currency)}`);
    }
  }
}