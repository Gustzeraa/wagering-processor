import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { UniqueConstraintViolationException } from '@mikro-orm/postgresql';
import {
  CurrencyMismatchError,
  IdempotencyConflictError,
  InvalidMoneyError,
  InvalidWagerTransactionError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../domain/errors';
import { RequestValidationError, ResourceNotFoundError } from './errors';
import { isTransientError } from '../infrastructure/transient-errors';

interface Mapped {
  status: number;
  code: string;
  retryable: boolean;
}

function classify(error: unknown): Mapped {
  if (
    error instanceof RequestValidationError ||
    error instanceof InvalidMoneyError ||
    error instanceof InvalidWagerTransactionError ||
    error instanceof CurrencyMismatchError
  ) {
    return { status: 400, code: error.code, retryable: false };
  }
  if (error instanceof WalletNotFoundError || error instanceof ResourceNotFoundError) {
    return { status: 404, code: error.code, retryable: false };
  }
  if (error instanceof IdempotencyConflictError || error instanceof WalletAlreadyExistsError) {
    return { status: 409, code: error.code, retryable: false };
  }
  if (error instanceof UniqueConstraintViolationException) {
    const code = error.message.includes('uq_wallet_player_currency')
      ? 'WALLET_ALREADY_EXISTS'
      : 'IDEMPOTENCY_CONFLICT';
    return { status: 409, code, retryable: false };
  }
  if (isTransientError(error)) {
    return { status: 503, code: 'TEMPORARILY_UNAVAILABLE', retryable: true };
  }
  if (error instanceof HttpException) {
    return { status: error.getStatus(), code: 'HTTP_ERROR', retryable: false };
  }
  return { status: 500, code: 'INTERNAL_ERROR', retryable: false };
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const mapped = classify(error);
    const message = error instanceof Error ? error.message : 'Unexpected error';

    if (mapped.status === 503) response.setHeader('Retry-After', '1');
    if (mapped.status >= 500) {
      this.logger.error({ msg: 'request failed', code: mapped.code, error: message });
    }

    // erros internos não expõem detalhes ao cliente
    const safeMessage = mapped.status === 500 ? 'Internal error' : message;
    response.status(mapped.status).json({
      error: { code: mapped.code, message: safeMessage, retryable: mapped.retryable },
    });
  }
}