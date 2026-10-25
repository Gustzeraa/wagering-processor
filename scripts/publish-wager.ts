/**
 * Publica uma WagerTransactionRequested na fila SQS.
 *
 * uso: bun scripts/publish-wager.ts <walletId> <playerId> [kind] [amount] [referenceExternalTransactionId]
 * ex.: bun scripts/publish-wager.ts 0192... player-1 BET 10.00
 */
import { GetQueueUrlCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createSqsClient, WAGER_QUEUE_NAME } from '../src/infrastructure/sqs';

async function main(): Promise<void> {
  const [walletId, playerId, kind = 'BET', amount = '10.00', reference] = process.argv.slice(2);
  if (!walletId || !playerId) {
    console.error(
      'usage: bun scripts/publish-wager.ts <walletId> <playerId> [kind] [amount] [referenceExternalTransactionId]',
    );
    process.exitCode = 1;
    return;
  }

  const sqs = createSqsClient();
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: WAGER_QUEUE_NAME }));

  const externalTransactionId = crypto.randomUUID();
  const envelope = {
    messageId: `msg-${externalTransactionId}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId,
      walletId,
      roundId: `round-${externalTransactionId}`,
      gameId: 'fortune-chimp',
      kind,
      money: { amount, currency: 'BRL' },
      ...(reference ? { referenceExternalTransactionId: reference } : {}),
    },
  };

  await sqs.send(
    new SendMessageCommand({
      QueueUrl,
      MessageBody: JSON.stringify(envelope),
      MessageGroupId: walletId,
      MessageDeduplicationId: envelope.messageId,
    }),
  );

  console.log(JSON.stringify({ messageId: envelope.messageId, externalTransactionId }));
}

void main();
