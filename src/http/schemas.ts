import { z } from 'zod';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const id = z.string().min(1).max(200);
const money = z.object({ amount: z.string(), currency: z.string() });

export const openWalletSchema = z.object({
  playerId: id,
  initialBalance: money,
});

export const wagerTransactionSchema = z.object({
  providerId: id,
  externalTransactionId: id,
  playerId: id,
  walletId: z.string().regex(UUID_PATTERN),
  roundId: id,
  gameId: id,
  kind: z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
  money,
  referenceExternalTransactionId: id.optional(),
});