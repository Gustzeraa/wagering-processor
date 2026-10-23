import { Controller, Get } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { AppService } from './app.service';

import {
  SQSClient,
  GetQueueUrlCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';

const sqs = new SQSClient({
  region: 'us-east-1',
  endpoint: process.env.AWS_ENDPOINT ?? 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly em: EntityManager,
  ) { }

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('db-check')
  async dbCheck() {
    return this.em.getConnection().execute('SELECT 1 AS ok');
  }

  @Get('sqs-check')
  async sqsCheck() {
    const { QueueUrl } = await sqs.send(
      new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }),
    );

    const id = crypto.randomUUID();
    await sqs.send(
      new SendMessageCommand({
        QueueUrl,
        MessageBody: JSON.stringify({ hello: 'world', id }),
        MessageGroupId: 'check',
        MessageDeduplicationId: id,
      }),
    );

    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 2 }),
    );

    for (const m of Messages) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: m.ReceiptHandle! }));
    }

    return { sent: id, received: Messages.map((m) => m.Body) };
  }
}