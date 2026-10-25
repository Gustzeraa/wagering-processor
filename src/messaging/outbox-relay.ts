import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { OutboxMessage } from '../domain/outbox-message';
import { SNS_CLIENT, WALLET_EVENTS_TOPIC_ARN } from '../infrastructure/sns';
import { systemClock } from '../infrastructure/system';
import { retries } from '../infrastructure/observability/metrics';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date | null;
}

@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('OutboxRelay');
  private running = false;
  private loop?: Promise<void>;

  constructor(
    private readonly em: EntityManager,
    @Inject(SNS_CLIENT) private readonly sns: SNSClient,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.WORKERS_ENABLED === 'false') return;
    this.running = true;
    this.loop = this.run();
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    await this.loop?.catch(() => undefined);
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const published = await this.publishBatch();
        if (published.length === 0) await sleep(500);
      } catch (error) {
        this.logger.error({ msg: 'outbox relay failed', error: String(error) });
        await sleep(1_000);
      }
    }
  }

  /**
   * Trava um lote de pendentes com SKIP LOCKED: várias instâncias trabalham em paralelo,
   * cada uma com linhas diferentes. Se esta instância morrer, a transação é desfeita,
   * os locks são liberados e outra instância publica.
   */
  async publishBatch(limit = 20): Promise<string[]> {
    return this.em.fork().transactional(async (tx) => {
      const rows = (await tx.execute(
        `SELECT id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at
         FROM outbox_message
         WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= now())
         ORDER BY occurred_at
         LIMIT ?
         FOR UPDATE SKIP LOCKED`,
        [limit],
      )) as unknown as OutboxRow[];

      const published: string[] = [];
      for (const row of rows) {
        const message = OutboxMessage.rehydrate({
          id: row.id,
          aggregateId: row.aggregate_id,
          eventType: row.event_type,
          payload: row.payload,
          occurredAt: new Date(row.occurred_at),
          attempts: row.attempts,
          nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at) : undefined,
        });
        const now = systemClock.now();

        try {
          await this.sns.send(
            new PublishCommand({
              TopicArn: WALLET_EVENTS_TOPIC_ARN,
              Message: JSON.stringify(message.payload),
              MessageAttributes: { eventType: { DataType: 'String', StringValue: message.eventType } },
            }),
          );
          message.markPublished(now);
          published.push(message.id);
        } catch (error) {
          message.scheduleRetry(now);
          retries.inc({ component: 'outbox' });
          this.logger.warn({
            msg: 'publish failed, will retry',
            eventId: message.id,
            attempts: message.attempts,
            error: String(error),
          });
        }

        await tx.execute(
          `UPDATE outbox_message SET attempts = ?, next_attempt_at = ?, published_at = ? WHERE id = ?`,
          [message.attempts, message.nextAttemptAt ?? null, message.publishedAt ?? null, message.id],
        );
      }
      return published;
    });
  }
}