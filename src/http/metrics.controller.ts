import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { registry } from '../infrastructure/observability/metrics';

@Controller('metrics')
export class MetricsController {
  @Get()
  async metrics(@Res({ passthrough: true }) res: Response): Promise<string> {
    res.setHeader('Content-Type', registry.contentType);
    return registry.metrics();
  }
}