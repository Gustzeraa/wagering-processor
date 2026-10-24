import { Logger } from '@nestjs/common';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Money, type MoneyProps } from '../domain/money';
import { WalletNotFoundError } from '../domain/errors';

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export class ReconcileWalletUseCase {
  private readonly logger = new Logger('Reconciliation');

  constructor(
    private readonly em: EntityManager,
    private readonly onMismatch: (walletId: string) => void = () => {},
  ) {}

  async execute(walletId: string): Promise<ReconciliationResult> {
    return this.em.fork().transactional(async (tx) => {
      // foto consistente do banco, sem travar ninguém
      await tx.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');

      const [wallet] = await tx.execute(
        'SELECT balance::text AS balance, currency FROM wallet WHERE id = ?',
        [walletId],
      );
      if (!wallet) throw new WalletNotFoundError(walletId);

      const [ledger] = await tx.execute(
        `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::text AS total,
                COUNT(*)::int AS entries
         FROM wallet_ledger_entry WHERE wallet_id = ?`,
        [walletId],
      );

      const stored = Money.fromMinorUnits(BigInt(wallet.balance), wallet.currency);
      const calculated = Money.fromMinorUnits(BigInt(ledger.total), wallet.currency);
      const difference = stored.subtract(calculated);
      const consistent = difference.isZero();

      if (!consistent) {
        // nunca corrige sozinho: registra e sinaliza
        this.logger.error({
          msg: 'wallet reconciliation mismatch',
          walletId,
          difference: difference.toString(),
          checkedEntries: ledger.entries,
        });
        this.onMismatch(walletId);
      }

      return {
        walletId,
        storedBalance: stored.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent,
        checkedEntries: ledger.entries,
      };
    });
  }
}