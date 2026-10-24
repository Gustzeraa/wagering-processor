import { InvalidTransactionStateError, InvalidWagerTransactionError } from './errors';
import { FailureCode } from './failure-code';
import { LedgerDirection } from './ledger-entry';
import { Money } from './money';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

/** Kinds aceitos pela API e pela fila. OPENING é só interno. */
export const EXTERNAL_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  /** Saldo observado ao chegar num estado terminal, para devolver no replay. */
  balanceAfter?: Money;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date;
}

export type CreateWagerTransactionProps = Omit<
  WagerTransactionState,
  | 'status'
  | 'referenceTransactionId'
  | 'failureCode'
  | 'processedAt'
  | 'balanceAfter'
  | 'referenceAttempts'
  | 'nextReferenceAttemptAt'
>;

const TERMINAL = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

const REFERENCE_REQUIRED = new Set([WagerTransactionKind.Refund, WagerTransactionKind.Rollback]);
const REFERENCE_OPTIONAL = new Set([WagerTransactionKind.Win]);

export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  /** id no provedor, não o id interno */
  readonly referenceExternalTransactionId: string | undefined;
  readonly createdAt: Date;

  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAt: Date | undefined;
  private _balanceAfter: Money | undefined;
  private _referenceAttempts: number;
  private _nextReferenceAttemptAt: Date | undefined;

  private constructor(s: WagerTransactionState) {
    this.id = s.id;
    this.providerId = s.providerId;
    this.externalTransactionId = s.externalTransactionId;
    this.idempotencyKey = s.idempotencyKey;
    this.payloadHash = s.payloadHash;
    this.walletId = s.walletId;
    this.playerId = s.playerId;
    this.roundId = s.roundId;
    this.gameId = s.gameId;
    this.kind = s.kind;
    this.money = s.money;
    this.referenceExternalTransactionId = s.referenceExternalTransactionId;
    this.createdAt = s.createdAt;
    this._status = s.status;
    this._referenceTransactionId = s.referenceTransactionId;
    this._failureCode = s.failureCode;
    this._processedAt = s.processedAt;
    this._balanceAfter = s.balanceAfter;
    this._referenceAttempts = s.referenceAttempts;
    this._nextReferenceAttemptAt = s.nextReferenceAttemptAt;
  }

  /** Nasce em PENDING. Valida referência e valor de acordo com o kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const hasReference = props.referenceExternalTransactionId !== undefined;

    if (REFERENCE_REQUIRED.has(props.kind) && !hasReference) {
      throw new InvalidWagerTransactionError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (hasReference && !REFERENCE_REQUIRED.has(props.kind) && !REFERENCE_OPTIONAL.has(props.kind)) {
      throw new InvalidWagerTransactionError(`${props.kind} cannot have a reference`);
    }

    const amountOk =
      props.kind === WagerTransactionKind.Loss ? !props.money.isNegative() : props.money.isPositive();
    if (!amountOk) {
      throw new InvalidWagerTransactionError(`Invalid amount for ${props.kind}`);
    }

    return new WagerTransaction({
      ...props,
      status: WagerTransactionStatus.Pending,
      referenceAttempts: 0,
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus { return this._status; }
  get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this._failureCode; }
  get processedAt(): Date | undefined { return this._processedAt; }
  get balanceAfter(): Money | undefined { return this._balanceAfter; }
  get referenceAttempts(): number { return this._referenceAttempts; }
  get nextReferenceAttemptAt(): Date | undefined { return this._nextReferenceAttemptAt; }

  // ---- transições

  markPendingReference(nextAttemptAt: Date): void {
    this.assertStatus([WagerTransactionStatus.Pending], WagerTransactionStatus.PendingReference);
    this._status = WagerTransactionStatus.PendingReference;
    this._nextReferenceAttemptAt = nextAttemptAt;
  }

  scheduleReferenceRetry(nextAttemptAt: Date): void {
    this.assertStatus([WagerTransactionStatus.PendingReference], WagerTransactionStatus.PendingReference);
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = nextAttemptAt;
  }

  markProcessed(referenceTransactionId: string | undefined, balanceAfter: Money, at: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.Processed);
    if (this.requiresReference() && referenceTransactionId === undefined) {
      throw new InvalidTransactionStateError(this.id, this._status, 'PROCESSED without reference');
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._balanceAfter = balanceAfter;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  reject(code: FailureCode, balanceAfter: Money): void {
    this.assertNotTerminal(WagerTransactionStatus.Rejected);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._balanceAfter = balanceAfter;
    this._nextReferenceAttemptAt = undefined;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal(WagerTransactionStatus.Failed);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextReferenceAttemptAt = undefined;
  }

  // ---- consultas

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return REFERENCE_REQUIRED.has(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** ROLLBACK inverte a direção da transação que ele desfaz. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference) {
          throw new InvalidTransactionStateError(this.id, this._status, 'ROLLBACK without reference');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Credit
          ? LedgerDirection.Debit
          : LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError(this.id, this._status, 'LOSS has no ledger direction');
    }
  }

  private assertNotTerminal(to: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.id, this._status, to);
    }
  }

  private assertStatus(allowed: WagerTransactionStatus[], to: WagerTransactionStatus): void {
    if (!allowed.includes(this._status)) {
      throw new InvalidTransactionStateError(this.id, this._status, to);
    }
  }
}