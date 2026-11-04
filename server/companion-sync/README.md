# Companion Sync Service

A small Node.js + PostgreSQL service for the SullyOS local-first companion sync protocol.

## Status

- Source implementation exists for one-time device pairing, per-device bearer tokens, device listing/revocation, explicit room-note text consent, push, pull, and ack.
- PostgreSQL migrations are source files only. They have **not** been applied to any database.
- No API process or cloud resource has been deployed. No user data has been uploaded.
- Do not point the app at this service until migrations and the integration tests have been run against a disposable PostgreSQL database.

## Runtime

Node.js 20+ and PostgreSQL 17+.

Required environment variables:

- `DATABASE_URL`: private PostgreSQL connection string. Do not expose PostgreSQL publicly.
- `COMPANION_BOOTSTRAP_TOKEN`: random secret of at least 32 characters. Used only for first-time owner setup and generating one-time pairing codes.
- `COMPANION_TOKEN_PEPPER`: independent random secret of at least 32 characters. Keep stable; rotating it invalidates every device token and pairing code.
- `COMPANION_CORS_ORIGINS`: comma-separated exact browser origins allowed to call the API, e.g. the actual deployed SullyOS origin. Never use `*` with bearer-token authentication.
- `PORT`: optional, defaults to 8787.
- `PGSSLMODE=disable`: only for a private local PostgreSQL socket/network where TLS is not configured. Otherwise TLS certificate verification is enabled.

Start with `pnpm start:companion-sync`.

## First-time owner setup

1. Apply migrations in order, `0001_initial.sql` then `0002_pairing_and_delivery.sql`, after a database backup and restore test.
2. Configure the environment variables through the server's secret manager. Never commit them.
3. Call `POST /v1/admin/setup` with `X-Companion-Bootstrap-Token`. It creates the single owner account and returns a one-time pairing code. Save it immediately.
4. A device redeems the code once using `POST /v1/devices/pair`. The returned device token is shown only once. Store it in an OS-protected credential store when the native Android client is implemented.
5. To add another device, call `POST /v1/admin/pairing-codes` with the bootstrap token and redeem the new one-time code.

## API

- `GET /v1/health`: minimal database health only.
- `POST /v1/admin/setup`: one-time owner initialization, protected by bootstrap token.
- `POST /v1/admin/pairing-codes`: issue a 10-minute one-time pairing code, protected by bootstrap token.
- `POST /v1/devices/pair`: redeem one-time code and receive an independent random device token.
- `GET /v1/devices`: list account devices; tokens are never returned.
- `DELETE /v1/devices/:id`: revoke another device. A device cannot revoke its own current token through this endpoint.
- `POST /v1/sync/policy`: explicitly enable or disable room-note text sync. Disabling removes server-side note event replicas, entity heads, and transport cursors.
- `POST /v1/sync/push`: idempotent batch push, up to 50 events.
- `GET /v1/sync/pull?cursor=0&limit=50`: pull events for enabled sync entities.
- `POST /v1/sync/ack`: monotonic acknowledgement bounded by the highest sequence delivered to this device.

## Security invariants

1. Every device gets its own random, revocable bearer token. PostgreSQL stores only an HMAC-SHA256 hash using `COMPANION_TOKEN_PEPPER`.
2. Resolve account and device identity from the token. Never authorize using account/device IDs supplied in request bodies.
3. Reject revoked devices and suspended accounts before reading or writing sync data.
4. Missing sync policy means local-only. The server accepts only the explicit `room_note` text entity in v1.
5. Validate room-note payloads against a strict field allowlist. Unknown fields, oversized batches, malformed identifiers, and non-empty delete payloads are rejected.
6. Event insert, entity version head update, and idempotency result are committed in a transaction. Per-event and per-entity advisory locks serialize concurrent requests.
7. Pull is account-scoped. Ack values cannot exceed the highest sequence delivered to that device.
8. Never log bearer tokens, pairing codes, provider secrets, request Authorization headers, note bodies, or raw payloads.
9. Provider credentials are not accepted by this API yet. When implemented, they must use envelope encryption with a key held outside PostgreSQL; task rows should contain references only.
10. Keep PostgreSQL private. Terminate TLS at the reverse proxy. Configure exact CORS origins only.

## Important limitations before production

- The frontend does not yet have a pairing UI or a sync transport client. The local Outbox/Inbox remains local-only.
- No automated migration runner or PostgreSQL integration test is included yet.
- The server currently supports room-note text only. It does not sync chat messages, diaries, media, or private images.
- Admin bootstrap is a single-owner setup flow, not a general user identity provider.
- Pairing-code issuance should be rate-limited at the reverse proxy before internet exposure.
- The device bearer token must be stored with Android Keystore-backed native storage before shipping the native APK. Browser-only storage is not an acceptable substitute for production secrets.
- No cloud deployment has been performed.

Do not run migrations or deploy this service until the owner explicitly approves cloud provisioning and the PostgreSQL integration suite passes.
