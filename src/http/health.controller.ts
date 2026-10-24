import { Controller, Get, HttpException, Inject } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { SQS_CLIENT, WAGER_QUEUE_NAME } from '../infrastructure/sqs';

const withTimeout = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

@Controller('health')
export class HealthController {
  constructor(
    private readonly em: EntityManager,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  /** Processo vivo. Não checa dependências de propósito. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Pronto para receber tráfego: PostgreSQL e SQS alcançáveis. */
  @Get('ready')
  async ready() {
    const [db, sqs] = await Promise.allSettled([
      withTimeout(this.em.getConnection().execute('SELECT 1'), 2000),
      withTimeout(this.sqs.send(new GetQueueUrlCommand({ QueueName: WAGER_QUEUE_NAME })), 2000),
    ]);
    const checks = {
      postgres: db.status === 'fulfilled' ? 'up' : 'down',
      sqs: sqs.status === 'fulfilled' ? 'up' : 'down',
    };
    if (checks.postgres === 'down' || checks.sqs === 'down') {
      throw new HttpException({ status: 'unavailable', checks }, 503);
    }
    return { status: 'ok', checks };
  }
}