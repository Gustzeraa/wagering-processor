export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_AMOUNT';
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, received: string) {
    super(`Currency mismatch: expected ${expected}, received ${received}`);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor(walletId: string) {
    super(`Insufficient funds in wallet ${walletId}`);
  }
}

export class InvalidLedgerEntryError extends DomainError {
  readonly code = 'INVALID_LEDGER_ENTRY';
}

export class InvalidWagerTransactionError extends DomainError {
  readonly code = 'INVALID_PAYLOAD';
}

/** Erro de programação: transição de estado proibida. Não é regra de negócio. */
export class InvalidTransactionStateError extends Error {
  constructor(transactionId: string, from: string, to: string) {
    super(`Transaction ${transactionId} cannot go from ${from} to ${to}`);
    this.name = 'InvalidTransactionStateError';
  }
}