import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { runWithLogContext } from '../infrastructure/observability/log-context';

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const header = req.headers['x-correlation-id'] ?? req.headers['idempotency-key'];
    const correlationId = (Array.isArray(header) ? header[0] : header) ?? crypto.randomUUID();
    res.setHeader('x-correlation-id', correlationId);
    runWithLogContext({ correlationId }, () => next());
  }
}