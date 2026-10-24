import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { OpenWalletUseCase } from '../application/open-wallet';
import { ReconcileWalletUseCase } from '../application/reconcile-wallet';
import { LedgerRepository, WalletRepository } from '../infrastructure/persistence/repositories';
import { inTransaction } from '../infrastructure/persistence/in-transaction';
import { WalletNotFoundError } from '../domain/errors';
import { AuthGuard } from './auth.guard';
import { assertUuid, parseBody, RequestValidationError } from './errors';
import { openWalletSchema } from './schemas';
import { presentLedgerEntry, presentWallet } from './presenters';

const encodeCursor = (version: number) => Buffer.from(JSON.stringify({ v: version })).toString('base64url');

function decodeCursor(cursor: string | undefined): number | undefined {
  if (!cursor) return undefined;
  try {
    const { v } = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { v: unknown };
    if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  } catch {
    // cai no erro abaixo
  }
  throw new RequestValidationError('Invalid cursor');
}

@Controller('wallets')
@UseGuards(AuthGuard)
export class WalletsController {
  constructor(
    private readonly em: EntityManager,
    private readonly openWallet: OpenWalletUseCase,
    private readonly reconcile: ReconcileWalletUseCase,
    private readonly wallets: WalletRepository,
    private readonly ledger: LedgerRepository,
  ) {}

  @Post()
  async create(@Body() body: unknown, @Headers('x-correlation-id') correlationId?: string) {
    const input = parseBody(openWalletSchema, body);
    const wallet = await inTransaction(this.em, (tx) =>
      this.openWallet.execute(input, tx, { correlationId: correlationId ?? crypto.randomUUID() }),
    );
    return presentWallet(wallet);
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    assertUuid(walletId, 'walletId');
    const wallet = await this.wallets.findById(this.em.fork(), walletId);
    if (!wallet) throw new WalletNotFoundError(walletId);
    return presentWallet(wallet);
  }

  @Get(':walletId/ledger')
  async getLedger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitParam?: string,
  ) {
    assertUuid(walletId, 'walletId');
    const limit = limitParam === undefined ? 50 : Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RequestValidationError('limit must be an integer between 1 and 100');
    }

    const em = this.em.fork();
    if (!(await this.wallets.findById(em, walletId))) throw new WalletNotFoundError(walletId);

    const rows = await this.ledger.page(em, walletId, decodeCursor(cursor), limit);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(presentLedgerEntry),
      nextCursor: rows.length > limit && last ? encodeCursor(last.walletVersion) : null,
    };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconciliation(@Param('walletId') walletId: string) {
    assertUuid(walletId, 'walletId');
    return this.reconcile.execute(walletId);
  }
}