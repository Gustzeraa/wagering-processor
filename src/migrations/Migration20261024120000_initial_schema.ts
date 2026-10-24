import { Migration } from '@mikro-orm/migrations';

export class Migration20261024120000_initial_schema extends Migration {
  override async up(): Promise<void> {
    // ---------- funções de proteção ----------
    this.addSql(`
      CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
      END;
      $$;
    `);

    this.addSql(`
      CREATE FUNCTION guard_wager_transaction_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'wager_transaction % is terminal (%)', OLD.id, OLD.status;
        END IF;
        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key,
            NEW.payload_hash, NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id,
            NEW.kind, NEW.amount, NEW.currency, NEW.reference_external_transaction_id,
            NEW.created_at)
           IS DISTINCT FROM
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key,
            OLD.payload_hash, OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id,
            OLD.kind, OLD.amount, OLD.currency, OLD.reference_external_transaction_id,
            OLD.created_at) THEN
          RAISE EXCEPTION 'wager_transaction business fields are immutable';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);

    // ---------- wallet ----------
    this.addSql(`
      CREATE TABLE wallet (
        id          UUID PRIMARY KEY,
        player_id   TEXT NOT NULL,
        currency    CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance     BIGINT NOT NULL CHECK (balance >= 0),
        version     INTEGER NOT NULL CHECK (version >= 1),
        created_at  TIMESTAMPTZ NOT NULL,
        updated_at  TIMESTAMPTZ NOT NULL,
        CONSTRAINT uq_wallet_player_currency UNIQUE (player_id, currency),
        CONSTRAINT uq_wallet_id_currency UNIQUE (id, currency)
      );
    `);

    // ---------- wager_transaction ----------
    this.addSql(`
      CREATE TABLE wager_transaction (
        id                                UUID PRIMARY KEY,
        provider_id                       TEXT NOT NULL,
        external_transaction_id           TEXT NOT NULL,
        idempotency_key                   TEXT NOT NULL,
        payload_hash                      CHAR(64) NOT NULL,
        wallet_id                         UUID NOT NULL,
        player_id                         TEXT NOT NULL,
        round_id                          TEXT NOT NULL,
        game_id                           TEXT NOT NULL,
        kind                              TEXT NOT NULL
          CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount                            BIGINT NOT NULL CHECK (amount >= 0),
        currency                          CHAR(3) NOT NULL,
        reference_external_transaction_id TEXT,
        reference_transaction_id          UUID,
        status                            TEXT NOT NULL
          CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code                      TEXT,
        processed_at                      TIMESTAMPTZ,
        balance_after                     BIGINT CHECK (balance_after >= 0),
        reference_attempts                INTEGER NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
        next_reference_attempt_at         TIMESTAMPTZ,
        created_at                        TIMESTAMPTZ NOT NULL,

        CONSTRAINT uq_tx_idempotency_key UNIQUE (idempotency_key),
        CONSTRAINT uq_tx_provider_external UNIQUE (provider_id, external_transaction_id),

        CONSTRAINT fk_tx_wallet FOREIGN KEY (wallet_id, currency)
          REFERENCES wallet (id, currency) DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT fk_tx_reference FOREIGN KEY (reference_transaction_id)
          REFERENCES wager_transaction (id) DEFERRABLE INITIALLY DEFERRED,

        CONSTRAINT ck_tx_amount_by_kind CHECK (kind = 'LOSS' OR amount > 0),
        CONSTRAINT ck_tx_reference_required CHECK (
          kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT ck_tx_reference_allowed CHECK (
          kind IN ('REFUND', 'ROLLBACK', 'WIN') OR reference_external_transaction_id IS NULL),
        CONSTRAINT ck_tx_processed_at CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
        CONSTRAINT ck_tx_failure_code CHECK (
          (status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT ck_tx_balance_on_decision CHECK (
          status NOT IN ('PROCESSED', 'REJECTED') OR balance_after IS NOT NULL),
        CONSTRAINT ck_tx_pending_reference_schedule CHECK (
          (status = 'PENDING_REFERENCE') = (next_reference_attempt_at IS NOT NULL)),
        CONSTRAINT ck_tx_reversal_resolved CHECK (
          status <> 'PROCESSED' OR kind NOT IN ('REFUND', 'ROLLBACK')
          OR reference_transaction_id IS NOT NULL)
      );
    `);

    this.addSql(`
      CREATE UNIQUE INDEX uq_tx_single_reversal ON wager_transaction (reference_transaction_id)
      WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED';
    `);
    this.addSql(`
      CREATE INDEX ix_tx_pending_reference ON wager_transaction (provider_id, reference_external_transaction_id)
      WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      CREATE INDEX ix_tx_pending_due ON wager_transaction (next_reference_attempt_at)
      WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      CREATE TRIGGER wager_transaction_guard_update BEFORE UPDATE ON wager_transaction
      FOR EACH ROW EXECUTE FUNCTION guard_wager_transaction_update();
    `);
    this.addSql(`
      CREATE TRIGGER wager_transaction_no_delete BEFORE DELETE ON wager_transaction
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
    `);

    // ---------- wallet_ledger_entry ----------
    this.addSql(`
      CREATE TABLE wallet_ledger_entry (
        id              UUID PRIMARY KEY,
        wallet_id       UUID NOT NULL,
        transaction_id  UUID NOT NULL,
        direction       TEXT NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
        amount          BIGINT NOT NULL CHECK (amount > 0),
        currency        CHAR(3) NOT NULL,
        balance_before  BIGINT NOT NULL CHECK (balance_before >= 0),
        balance_after   BIGINT NOT NULL CHECK (balance_after >= 0),
        wallet_version  INTEGER NOT NULL CHECK (wallet_version >= 1),
        created_at      TIMESTAMPTZ NOT NULL,

        CONSTRAINT uq_ledger_transaction_wallet UNIQUE (transaction_id, wallet_id),
        CONSTRAINT uq_ledger_wallet_version UNIQUE (wallet_id, wallet_version),
        CONSTRAINT fk_ledger_wallet FOREIGN KEY (wallet_id, currency)
          REFERENCES wallet (id, currency) DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT fk_ledger_transaction FOREIGN KEY (transaction_id)
          REFERENCES wager_transaction (id) DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT ck_ledger_balanced CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount))
      );
    `);
    this.addSql(`
      CREATE INDEX ix_ledger_wallet_page ON wallet_ledger_entry (wallet_id, wallet_version DESC);
    `);
    this.addSql(`
      CREATE TRIGGER ledger_no_update_delete BEFORE UPDATE OR DELETE ON wallet_ledger_entry
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
    `);
    this.addSql(`
      CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entry
      FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
    `);

    // ---------- inbox ----------
    this.addSql(`
      CREATE TABLE inbox_message (
        consumer_name  TEXT NOT NULL,
        message_id     TEXT NOT NULL,
        payload_hash   CHAR(64) NOT NULL,
        received_at    TIMESTAMPTZ NOT NULL,
        processed_at   TIMESTAMPTZ,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    // ---------- outbox ----------
    this.addSql(`
      CREATE TABLE outbox_message (
        id               UUID PRIMARY KEY,
        aggregate_id     UUID NOT NULL,
        event_type       TEXT NOT NULL,
        payload          JSONB NOT NULL,
        occurred_at      TIMESTAMPTZ NOT NULL,
        attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at  TIMESTAMPTZ,
        published_at     TIMESTAMPTZ
      );
    `);
    this.addSql(`
      CREATE INDEX ix_outbox_pending ON outbox_message (occurred_at)
      WHERE published_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE outbox_message;`);
    this.addSql(`DROP TABLE inbox_message;`);
    this.addSql(`DROP TABLE wallet_ledger_entry;`);
    this.addSql(`DROP TABLE wager_transaction;`);
    this.addSql(`DROP TABLE wallet;`);
    this.addSql(`DROP FUNCTION guard_wager_transaction_update();`);
    this.addSql(`DROP FUNCTION forbid_mutation();`);
  }
}