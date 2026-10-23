import { Controller, Get } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly em: EntityManager,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('db-check')
  async dbCheck() {
    return this.em.getConnection().execute('SELECT 1 AS ok');
  }
}