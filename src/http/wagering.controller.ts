import { Body, Controller, Get, Headers, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { EntityManager } from '@mikro-orm/postgresql';
import { ProcessWagerTransactionUseCase } from '../application/process-wager-transaction';
import { WagerTransactionRepository } from '../infrastructure/persistence/repositories';
import { inTransaction } from '../infrastructure/persistence/in-transaction';
import { WagerTransactionStatus as Status } from '../domain/wager-transaction';
import { AuthGuard } from './auth.guard';
import { assertUuid, parseBody, RequestValidationError, ResourceNotFoundError } from './errors';
import { wagerTransactionSchema } from './schemas';
import { presentSubmission, presentTransaction } from './presenters';

@Controller()
@UseGuards(AuthGuard)
export class WageringController {
  constructor(
    private readonly em: EntityManager,
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly transactions: WagerTransactionRepository,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey || idempotencyKey.length > 300) {
      throw new RequestValidationError('Idempotency-Key header is required');
    }
    const input = parseBody(wagerTransactionSchema, body);

    const { transaction, replay } = await inTransaction(this.em, (tx) =>
      this.processWager.execute(
        { ...input, idempotencyKey },
        tx,
        { correlationId: correlationId ?? idempotencyKey },
      ),
    );

    res.status(
      transaction.status === Status.Processed ? (replay ? 200 : 201)
      : transaction.status === Status.PendingReference ? 202
      : transaction.status === Status.Rejected ? 422
      : 500,
    );
    return presentSubmission(transaction, replay);
  }

  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId') transactionId: string) {
    assertUuid(transactionId, 'transactionId');
    const t = await this.transactions.findById(this.em.fork(), transactionId);
    if (!t) throw new ResourceNotFoundError(`Transaction ${transactionId} not found`);
    return presentTransaction(t);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const t = await this.transactions.findByProviderExternalId(this.em.fork(), providerId, externalTransactionId);
    if (!t) throw new ResourceNotFoundError(`Transaction ${providerId}/${externalTransactionId} not found`);
    return presentTransaction(t);
  }
}