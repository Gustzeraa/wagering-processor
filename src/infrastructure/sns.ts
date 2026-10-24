import { SNSClient } from '@aws-sdk/client-sns';

export const SNS_CLIENT = Symbol('SNS_CLIENT');

export const WALLET_EVENTS_TOPIC_ARN =
  process.env.WALLET_EVENTS_TOPIC_ARN ?? 'arn:aws:sns:us-east-1:000000000000:wallet-events';

export function createSnsClient(): SNSClient {
  return new SNSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.AWS_ENDPOINT ?? 'http://localhost:4566',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
}