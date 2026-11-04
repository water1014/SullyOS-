-- Companion sync service v1. PostgreSQL 17+.
-- Apply only when the VPS service is intentionally provisioned. This migration
-- creates schema objects; it does not create users, credentials, or devices.

BEGIN;

CREATE TABLE IF NOT EXISTS companion_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_subject TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended', 'deleted')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS companion_devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES companion_accounts(id) ON DELETE CASCADE,
    label VARCHAR(24) NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'web', 'desktop', 'unknown')),
    app_version TEXT,
    token_hash BYTEA NOT NULL UNIQUE,
    token_version INTEGER NOT NULL DEFAULT 1 CHECK (token_version > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    UNIQUE (account_id, id)
);
CREATE INDEX IF NOT EXISTS companion_devices_account_active_idx
    ON companion_devices (account_id, created_at DESC) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS companion_sync_policies (
    account_id UUID NOT NULL REFERENCES companion_accounts(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('room_note')),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    mode TEXT NOT NULL DEFAULT 'local_only' CHECK (mode IN ('local_only', 'text')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, entity_type),
    CHECK ((enabled AND mode = 'text') OR (NOT enabled AND mode = 'local_only'))
);

CREATE TABLE IF NOT EXISTS companion_sync_events (
    server_sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
    event_id UUID NOT NULL,
    account_id UUID NOT NULL REFERENCES companion_accounts(id) ON DELETE CASCADE,
    device_id UUID NOT NULL,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('room_note')),
    entity_id TEXT NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 256),
    operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
    base_version BIGINT NOT NULL DEFAULT 0 CHECK (base_version >= 0),
    entity_version BIGINT NOT NULL CHECK (entity_version > 0),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    client_created_at TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, event_id),
    FOREIGN KEY (account_id, device_id)
        REFERENCES companion_devices(account_id, id) ON DELETE CASCADE,
    CHECK (jsonb_typeof(payload) = 'object'),
    CHECK (operation <> 'delete' OR payload = '{}'::jsonb)
);
CREATE INDEX IF NOT EXISTS companion_sync_events_pull_idx
    ON companion_sync_events (account_id, server_sequence);
CREATE INDEX IF NOT EXISTS companion_sync_events_entity_idx
    ON companion_sync_events (account_id, entity_type, entity_id, entity_version);

CREATE TABLE IF NOT EXISTS companion_sync_entity_heads (
    account_id UUID NOT NULL REFERENCES companion_accounts(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('room_note')),
    entity_id TEXT NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 256),
    current_version BIGINT NOT NULL CHECK (current_version > 0),
    last_event_id UUID NOT NULL,
    deleted_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS companion_device_cursors (
    account_id UUID NOT NULL,
    device_id UUID NOT NULL,
    last_acked_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_acked_sequence >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, device_id),
    FOREIGN KEY (account_id, device_id)
        REFERENCES companion_devices(account_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS companion_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES companion_accounts(id) ON DELETE CASCADE,
    character_id TEXT,
    task_type TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'leased', 'running', 'completed', 'failed', 'cancelled')),
    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_owner TEXT,
    lease_until TIMESTAMPTZ,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
    idempotency_key TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    result_event_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, idempotency_key),
    CHECK (jsonb_typeof(payload) = 'object')
);
CREATE INDEX IF NOT EXISTS companion_tasks_schedule_idx
    ON companion_tasks (state, scheduled_at);
CREATE INDEX IF NOT EXISTS companion_tasks_lease_idx
    ON companion_tasks (lease_until) WHERE state IN ('leased', 'running');

CREATE TABLE IF NOT EXISTS companion_provider_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES companion_accounts(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    label VARCHAR(80) NOT NULL,
    encrypted_secret BYTEA NOT NULL,
    key_version INTEGER NOT NULL CHECK (key_version > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS companion_provider_credentials_active_idx
    ON companion_provider_credentials (account_id, provider) WHERE revoked_at IS NULL;

COMMIT;
