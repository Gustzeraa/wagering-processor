import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ProcessWagerTransactionUseCase } from '../application/process-wager-transaction';
import { InboxRepository } from '../infrastructure/persistence/repositories';
import { inTransaction } from '../infrastructure/persistence/in-transaction';
import { isTransientError } from '../infrastructure/transient-errors';
import { SQS_CLIENT, WAGER_DLQ_NAME, WAGER_QUEUE_NAME } from '../infrastructure/sqs';
import { systemClock } from '../infrastructure/system';
import { DomainError } from '../domain/errors';
import { InboxConflictError, InboxMessage } from '../domain/inbox-message';
import { canonicalJson } from '../domain/payload-hash';
import { parseBody, RequestValidationError } from '../http/errors';
import { wagerTransactionSchema } from '../http/schemas';

const envelopeSchema = z.object({
  messageId: z.string().min(1).max(200),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.string(),
  data: wagerTransactionSchema.extend({ idempotencyKey: z.string().min(1).max(300) }),
});
type Envelope = z.infer<typeof envelopeSchema>;

export type ProcessOutcome = 'processed' | 'duplicate';
export type HandleOutcome = ProcessOutcome | 'retry' | 'dead-lettered';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class WagerTransactionConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  static readonly CONSUMER_NAME = 'wager-transaction-processor';

  private readonly logger = new Logger('WagerConsumer');
  private readonly inFlight = new Map<string, Promise<HandleOutcome>>();
  private readonly abort = new AbortController();
  private running = false;
  private loop?: Promise<void>;
  private queueUrl?: string;
  private dlqUrl?: string;

  constructor(
    private readonly em: EntityManager,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly inbox: InboxRepository,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.WORKERS_ENABLED === 'false') return;
    this.running = true;
    this.loop = this.run();
  }

  /** SIGTERM: para de buscar, espera as em andamento e devolve as que não terminaram. */
  async onApplicationShutdown(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort.abort();

    await Promise.race([Promise.allSettled([...this.inFlight.values()]), sleep(8_000)]);

    const queueUrl = await this.getQueueUrl();
    for (const receiptHandle of this.inFlight.keys()) {
      await this.sqs
        .send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: 0 }))
        .catch(() => undefined);
    }
    await this.loop?.catch(() => undefined);
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce(this.abort.signal);
      } catch (error) {
        if (!this.running) break;
        this.logger.error({ msg: 'poll failed', error: String(error) });
        await sleep(1_000);
      }
    }
  }

  /** Busca um lote e processa em paralelo. waitSeconds é o tempo de long polling. */
  async pollOnce(signal?: AbortSignal, waitSeconds = 5): Promise<HandleOutcome[]> {
    const { Messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.getQueueUrl(),
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitSeconds,
        AttributeNames: ['All'],
      }),
      { abortSignal: signal },
    );
    return Promise.all(Messages.map((m) => this.track(m)));
  }

  private track(message: Message): Promise<HandleOutcome> {
    const handle = message.ReceiptHandle ?? '';
    const promise = this.handle(message).finally(() => this.inFlight.delete(handle));
    this.inFlight.set(handle, promise);
    return promise;
  }

  /** Processa, e só confirma (apaga da fila) depois do commit. */
  async handle(message: Message): Promise<HandleOutcome> {
    try {
      const outcome = await this.processMessage(message.Body ?? '');

      // injeção de falha para o teste "worker morto depois do commit e antes do ack"
      if (process.env.CRASH_AFTER_COMMIT === 'true') process.exit(1);

      await this.sqs.send(
        new DeleteMessageCommand({ QueueUrl: await this.getQueueUrl(), ReceiptHandle: message.ReceiptHandle }),
      );
      return outcome;
    } catch (error) {
      if (this.isPermanent(error)) {
        await this.deadLetter(message, error);
        return 'dead-lettered';
      }
      await this.retryLater(message, error);
      return 'retry';
    }
  }

  /** Inbox + caso de uso na mesma transação. Lança erro em qualquer falha. */
  async processMessage(body: string): Promise<ProcessOutcome> {
    const envelope: Envelope = parseBody(envelopeSchema, JSON.parse(body));
    const now = systemClock.now();
    const inboxMessage = InboxMessage.receive({
      messageId: envelope.messageId,
      consumerName: WagerTransactionConsumer.CONSUMER_NAME,
      payloadHash: createHash('sha256').update(canonicalJson(envelope.data)).digest('hex'),
      receivedAt: now,
    });

    return inTransaction(this.em, async (tx) => {
      const receipt = await this.inbox.tryReceive(tx, inboxMessage);
      if (receipt === 'duplicate') return 'duplicate';
      if (receipt === 'conflict') throw new InboxConflictError(envelope.messageId);

      await this.processWager.execute(envelope.data, tx, {
        correlationId: envelope.messageId,
        causationId: envelope.messageId,
      });

      inboxMessage.markProcessed(systemClock.now());
      await this.inbox.markProcessed(tx, inboxMessage);
      return 'processed';
    });
  }

  /** Negócio já vira REJECTED dentro do caso de uso; o que chega aqui como DomainError é payload ruim. */
  private isPermanent(error: unknown): boolean {
    if (isTransientError(error)) return false;
    return error instanceof DomainError || error instanceof RequestValidationError || error instanceof SyntaxError;
  }

  private async retryLater(message: Message, error: unknown): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    const delaySeconds = Math.min(2 ** receiveCount, 300);
    this.logger.warn({
      msg: 'transient failure, retrying later',
      messageId: message.MessageId,
      receiveCount,
      delaySeconds,
      error: String(error),
    });
    await this.sqs
      .send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: await this.getQueueUrl(),
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: delaySeconds,
        }),
      )
      .catch(() => undefined); // se falhar, o visibility timeout padrão devolve a mensagem
  }

  private async deadLetter(message: Message, error: unknown): Promise<void> {
    const reason =
      error instanceof DomainError || error instanceof RequestValidationError ? error.code : 'INVALID_MESSAGE';
    this.logger.error({ msg: 'permanent failure, sending to DLQ', messageId: message.MessageId, reason });
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: await this.getDlqUrl(),
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: { reason: { DataType: 'String', StringValue: reason } },
      }),
    );
    await this.sqs.send(
      new DeleteMessageCommand({ QueueUrl: await this.getQueueUrl(), ReceiptHandle: message.ReceiptHandle }),
    );
  }

  private async getQueueUrl(): Promise<string> {
    this.queueUrl ??= (await this.sqs.send(new GetQueueUrlCommand({ QueueName: WAGER_QUEUE_NAME }))).QueueUrl ?? '';
    return this.queueUrl;
  }

  private async getDlqUrl(): Promise<string> {
    this.dlqUrl ??= (await this.sqs.send(new GetQueueUrlCommand({ QueueName: WAGER_DLQ_NAME }))).QueueUrl ?? '';
    return this.dlqUrl;
  }
}