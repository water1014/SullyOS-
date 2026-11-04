BEGIN;

CREATE TABLE IF NOT EXISTS companion_sync_account_state (
    account_id UUID PRIMARY KEY REFERENCES companion_accounts(id) ON DELETE CASCADE,
    last_server_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_server_sequence >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
