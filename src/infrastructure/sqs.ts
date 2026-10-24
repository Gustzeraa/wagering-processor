import { SQSClient } from '@aws-sdk/client-sqs';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

export const WAGER_QUEUE_NAME = process.env.WAGER_QUEUE_NAME ?? 'wager-transactions.fifo';
export const WAGER_DLQ_NAME = process.env.WAGER_DLQ_NAME ?? 'wager-transactions-dlq.fifo';

export function createSqsClient(): SQSClient {
  return new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.AWS_ENDPOINT ?? 'http://localhost:4566',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
}