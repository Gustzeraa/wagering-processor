import { InsufficientFundsError, InvalidMoneyError } from './errors';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import { Money } from './money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Identificadores e momento de uma movimentação, fornecidos por quem chama. */
export interface MovementContext {
  transactionId: string;
  entryId: string;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a wallet já com o saldo inicial, na versão 1.
   * Se o saldo inicial for positivo, devolve o lançamento de abertura (OPENING).
   */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    opening: MovementContext;
  }): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
    const { id, playerId, initialBalance, opening } = props;
    if (initialBalance.isNegative()) {
      throw new InvalidMoneyError('Initial balance cannot be negative');
    }

    const wallet = new Wallet(
      id, playerId, initialBalance.currency, initialBalance, 1, opening.at, opening.at,
    );
    if (initialBalance.isZero()) {
      return { wallet };
    }

    const openingEntry = WalletLedgerEntry.create({
      id: opening.entryId,
      walletId: id,
      transactionId: opening.transactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      walletVersion: 1,
      createdAt: opening.at,
    });
    return { wallet, openingEntry };
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id, state.playerId, state.currency, state.balance,
      state.version, state.createdAt, state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(money: Money, ctx: MovementContext): WalletLedgerEntry {
    this.assertMovement(money);
    if (this._balance.isLessThan(money)) {
      throw new InsufficientFundsError(this.id);
    }
    return this.apply(LedgerDirection.Debit, money, ctx);
  }

  credit(money: Money, ctx: MovementContext): WalletLedgerEntry {
    this.assertMovement(money);
    return this.apply(LedgerDirection.Credit, money, ctx);
  }

  private apply(direction: LedgerDirection, money: Money, ctx: MovementContext): WalletLedgerEntry {
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(money) : before.subtract(money);

    const entry = WalletLedgerEntry.create({
      id: ctx.entryId,
      walletId: this.id,
      transactionId: ctx.transactionId,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
      walletVersion: this._version + 1,
      createdAt: ctx.at,
    });

    this._balance = after;
    this._version += 1;
    this._updatedAt = ctx.at;
    return entry;
  }

  private assertMovement(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidMoneyError('Movement amount must be positive');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      // reaproveita a mesma regra do Money
      Money.zero(this.currency).add(money);
    }
  }
}