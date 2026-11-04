# Companion Sync Service

Node.js + PostgreSQL service for SullyOS local-first companion sync.

## Current implementation status

Implemented in the feature branch:
- One-time owner setup and one-time pairing codes.
- Per-device bearer tokens, token hashing, device listing and revocation.
- Frontend pairing UI in Settings, manual sync action, and disconnect action.
- Android-native secure credential storage integration when running inside the Capacitor Android app. Browser preview storage is temporary and is not production-safe.
- Explicit local and remote room-note text consent.
- Outbox push, inbox pull/apply, acknowledgements, conflict resolution, and restore-safe transport reset.
- PostgreSQL integration test harness and protocol tests.

Not yet complete:
- No server/database has been deployed or provisioned.
- No migrations have been applied to a production database.
- No real Android APK has been built or device-tested.
- Sync currently supports room-note text only. Chat, diaries, media, private images, and autonomous tasks are not synced by this service.
- Device listing/revocation UI beyond disconnecting the current device remains to be finished.
- Background sync/push notifications are not implemented.

**Do not enter a real server URL until the service has been deployed and tested.** No user data is uploaded by this repository update.

## Runtime

Node.js 20+ and PostgreSQL 17+.

Environment variables:
- `DATABASE_URL`: private PostgreSQL connection string. Never expose PostgreSQL publicly.
- `COMPANION_BOOTSTRAP_TOKEN`: random secret, at least 32 characters. Used for first-time owner setup and issuing pairing codes.
- `COMPANION_TOKEN_PEPPER`: independent random secret, at least 32 characters. Keep stable; rotating it invalidates device tokens and pairing codes.
- `COMPANION_CORS_ORIGINS`: comma-separated exact browser origins allowed to call the API. Never use `*` with bearer-token authentication.
- `PORT`: optional, defaults to 8787.
- `PGSSLMODE=disable`: only for a private local database network where TLS is intentionally terminated elsewhere. Otherwise certificate verification is enabled.

Start with `pnpm start:companion-sync`.

## First-time owner setup

1. Provision a disposable PostgreSQL database first.
2. Apply migrations in order: `0001_initial.sql`, `0002_pairing_and_delivery.sql`, then `0003_account_sequence_watermark.sql`.
3. Run `pnpm test:companion-sync-integration` against that disposable database and verify a backup restore before production.
4. Configure secrets through the host's secret manager. Never commit them.
5. Call `POST /v1/admin/setup` with `X-Companion-Bootstrap-Token`. Save the one-time pairing code securely.
6. Enter the HTTPS service URL and pairing code in SullyOS Settings. Pairing returns a device-specific token, stored through Android Keystore in the native Android app.
7. Enable room-note text sync on the device and press **立即同步** to transfer. Pairing alone does not enable data sync.

## API

- `GET /v1/health`: minimal database health.
- `POST /v1/admin/setup`: one-time owner initialization.
- `POST /v1/admin/pairing-codes`: issue a 10-minute one-time pairing code.
- `POST /v1/devices/pair`: redeem a pairing code and receive an independent device token.
- `GET /v1/devices`: list account devices; tokens are never returned.
- `DELETE /v1/devices/:id`: revoke another device.
- `POST /v1/devices/current/revoke`: revoke the current device token.
- `POST /v1/sync/policy`: explicitly enable/disable room-note text sync.
- `POST /v1/sync/push`: idempotent batch push, up to 50 events.
- `GET /v1/sync/pull?cursor=0&limit=50`: pull authorized events.
- `POST /v1/sync/ack`: monotonic acknowledgement bounded by the highest sequence delivered to the device.

## Security invariants

1. Each device gets an independent random revocable token. PostgreSQL stores only an HMAC-SHA256 hash using `COMPANION_TOKEN_PEPPER`.
2. Account and device identity are resolved from the token, never trusted from request-body IDs.
3. Revoked devices and suspended accounts are rejected before sync data access.
4. Missing policy means local-only. V1 accepts only allowlisted room-note text.
5. Payloads are strictly validated; unknown fields, oversized batches, malformed IDs, and non-empty delete payloads are rejected.
6. Event insert, entity version update, and idempotency result are transactional.
7. Pull is account-scoped. Acknowledgements cannot exceed the highest sequence delivered to that device.
8. Never log bearer tokens, pairing codes, provider secrets, Authorization headers, note bodies, or raw payloads.
9. Provider credentials are not accepted by this API. Future credentials require envelope encryption with a key outside PostgreSQL.
10. Keep PostgreSQL private, terminate TLS at a reverse proxy, and configure exact CORS origins.

## Deployment gate

Cloud provisioning is intentionally deferred. Do not deploy, apply production migrations, or upload user data until the owner explicitly approves provisioning and the disposable PostgreSQL integration suite passes. Use a low-cost test environment first; verify restore and revocation before enabling real sync.
