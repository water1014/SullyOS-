BEGIN;

CREATE TABLE IF NOT EXISTS companion_pairing_codes (
    code_hash BYTEA PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES companion_accounts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS companion_pairing_codes_expiry_idx
    ON companion_pairing_codes (expires_at) WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS companion_device_deliveries (
    account_id UUID NOT NULL,
    device_id UUID NOT NULL,
    max_delivered_sequence BIGINT NOT NULL DEFAULT 0 CHECK (max_delivered_sequence >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, device_id),
    FOREIGN KEY (account_id, device_id)
        REFERENCES companion_devices(account_id, id) ON DELETE CASCADE
);

COMMIT;
