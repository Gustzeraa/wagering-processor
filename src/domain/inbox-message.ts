import { DomainError } from './errors';

export class InboxConflictError extends DomainError {
  readonly code = 'INBOX_CONFLICT';

  constructor(messageId: string) {
    super(`Message ${messageId} was already received with a different payload`);
  }
}

export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: {
    messageId: string;
    consumerName: string;
    payloadHash: string;
    receivedAt: Date;
  }): InboxMessage {
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt);
  }

  static rehydrate(state: {
    messageId: string;
    consumerName: string;
    payloadHash: string;
    receivedAt: Date;
    processedAt?: Date;
  }): InboxMessage {
    return new InboxMessage(
      state.messageId, state.consumerName, state.payloadHash, state.receivedAt, state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this._processedAt) {
      throw new Error(`Inbox message ${this.messageId} already processed`);
    }
    this._processedAt = at;
  }
}