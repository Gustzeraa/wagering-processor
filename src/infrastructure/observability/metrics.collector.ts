import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { gaugeSources } from './metrics';
import { SQS_CLIENT, WAGER_DLQ_NAME } from '../sqs';

@Injectable()
export class MetricsCollector implements OnModuleInit {
  constructor(
    private readonly em: EntityManager,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  onModuleInit(): void {
    gaugeSources.outbox = async () => {
      const [row] = (await this.em.fork().getConnection().execute(
        `SELECT COUNT(*)::int AS pending,
                COALESCE(EXTRACT(EPOCH FROM now() - MIN(occurred_at)), 0)::float AS lag
         FROM outbox_message WHERE published_at IS NULL`,
      )) as unknown as { pending: number; lag: number }[];
      return { pending: row?.pending ?? 0, lagSeconds: row?.lag ?? 0 };
    };

    gaugeSources.dlqDepth = async () => {
      const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: WAGER_DLQ_NAME }));
      const { Attributes } = await this.sqs.send(
        new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['ApproximateNumberOfMessages'] }),
      );
      return Number(Attributes?.ApproximateNumberOfMessages ?? 0);
    };
  }
}