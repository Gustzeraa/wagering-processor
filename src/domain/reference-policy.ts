import { FailureCode } from './failure-code';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from './wager-transaction';

const ALLOWED_REFERENCE_KINDS: Partial<Record<Kind, Kind[]>> = {
  [Kind.Win]: [Kind.Bet],
  [Kind.Refund]: [Kind.Bet],
  [Kind.Rollback]: [Kind.Bet, Kind.Win, Kind.Refund],
};

export type ReferenceDecision =
  | { outcome: 'wait' }
  | { outcome: 'reject'; code: FailureCode }
  | { outcome: 'accept'; reference: WagerTransaction };

export function evaluateReference(
  t: WagerTransaction,
  reference: WagerTransaction | null,
  alreadyReversed: boolean,
): ReferenceDecision {
  // ainda não chegou, ou chegou mas também está pendente: espera
  if (!reference || reference.status === Status.Pending || reference.status === Status.PendingReference) {
    return { outcome: 'wait' };
  }
  if (
    reference.walletId !== t.walletId ||
    reference.playerId !== t.playerId ||
    reference.roundId !== t.roundId ||
    reference.money.currency !== t.money.currency
  ) {
    return { outcome: 'reject', code: FailureCode.ReferenceMismatch };
  }
  if (!ALLOWED_REFERENCE_KINDS[t.kind]?.includes(reference.kind)) {
    return { outcome: 'reject', code: FailureCode.ReferenceInvalidKind };
  }
  if (reference.status !== Status.Processed) {
    return { outcome: 'reject', code: FailureCode.ReferenceNotProcessed };
  }
  if (t.requiresReference()) {
    if (alreadyReversed) {
      return { outcome: 'reject', code: FailureCode.AlreadyReversed };
    }
    if (!reference.money.equals(t.money)) {
      return { outcome: 'reject', code: FailureCode.ReferenceAmountMismatch };
    }
  }
  return { outcome: 'accept', reference };
}