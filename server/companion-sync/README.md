# Companion Sync Service

This directory is the source-only foundation for the future companion sync service.

## Current status

- `migrations/0001_initial.sql` defines the initial PostgreSQL schema.
- No API process, database connection, device pairing endpoint, or worker is implemented yet.
- The migration has **not** been applied to any database.
- No cloud resources have been created or deployed.

## Security invariants for the API implementation

1. Every device receives its own random, revocable bearer token. Store only a cryptographic hash in `companion_devices.token_hash`; never reuse a shared account-wide token.
2. Resolve the authenticated account and device from the token hash. Ignore account/device IDs supplied in request bodies for authorization.
3. Reject revoked devices and suspended accounts before reading or writing sync data.
4. Require an enabled `companion_sync_policies` row for the entity type. Missing policy means local-only.
5. Validate each room-note payload against an explicit allowlist. Reject unknown fields, oversized batches, malformed identifiers, and non-empty delete payloads.
6. Process an event insert, entity-head version update, and idempotency result in one database transaction.
7. Pull events only for the authenticated account. Ack values must be monotonic and no greater than the highest sequence actually delivered to that device.
8. Never log bearer tokens, provider secrets, note bodies, request Authorization headers, or raw payloads.
9. Keep provider credentials encrypted with an envelope-encryption key held outside PostgreSQL. Task rows contain credential references only.
10. Do not expose PostgreSQL to the public network. Terminate TLS at the reverse proxy.

## Migration

Use PostgreSQL 17 or later. The migration uses `gen_random_uuid()` and standard PostgreSQL identity columns.

Do not run the migration until the service deployment is explicitly approved and a database backup/restore procedure has been tested.
