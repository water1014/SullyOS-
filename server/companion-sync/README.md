# Companion Sync Service

Node.js + PostgreSQL service for SullyOS local-first companion sync.

## Current implementation status

Implemented on `feature/image-studio`:
- One-time owner setup and expiring one-time pairing codes.
- Independent per-device bearer tokens, token hashing, device listing and revocation.
- Settings UI for pairing, manual sync, disconnect, device management and retrying consent changes.
- Android-native secure credential storage integration when running inside the Capacitor Android app. Browser preview storage is volatile memory only and is not production-safe.
- Explicit local and remote room-note text consent.
- Outbox push, inbox pull/apply, acknowledgements, conflict resolution, stale in-flight recovery and restore-safe transport reset.
- PostgreSQL integration test harness and protocol tests.
- Docker image, private PostgreSQL + API + Caddy Compose stack, and repeatable SQL migration runner.

Not yet complete:
- The server has **not** been provisioned or deployed to a live VPS.
- No production database has been created and no production migrations have been applied.
- Sync currently supports room-note text only. Chat, diaries, media, private images, screen context and autonomous tasks are not synced by this service.
- Background sync and push notifications are not implemented.
- No final Android APK has been compiled or tested on the user's phone. The Capacitor wrapper project is maintained separately from this repository.
- The APK update manifest remains disabled until a release APK, stable signing identity and hosting URL exist.

No user data is uploaded by these repository changes. Do not enter a live server URL in Settings until the server has been provisioned, migrated, health-checked and backed up.

## VPS deployment

The Compose stack is designed for a small Ubuntu VPS (2 vCPU / 2 GB RAM) with a domain name pointed at the server. It keeps PostgreSQL on a private Docker network; only Caddy publishes ports 80 and 443.

### 1. Prepare the host

1. Provision an Ubuntu 24.04 VPS and point a DNS A record (and AAAA record only if IPv6 is configured) for your sync subdomain to its public IP.
2. Allow inbound TCP 80 and 443. UDP 443 is optional but improves HTTP/3. Keep SSH restricted to your own IP where possible.
3. Install Docker Engine and the Docker Compose plugin.
4. Clone this repository and check out `feature/image-studio`. On the VPS, enter `server/companion-sync`.

### 2. Configure secrets

```sh
cd server/companion-sync
cp .env.example .env
openssl rand -hex 32
```

Generate three independent random values and put them into `.env`:
- `POSTGRES_PASSWORD`
- `COMPANION_BOOTSTRAP_TOKEN`
- `COMPANION_TOKEN_PEPPER`

Set `COMPANION_DOMAIN` to the DNS name and `ACME_EMAIL` to an address for certificate expiry notices. Keep `COMPANION_CORS_ORIGINS` as exact origins only. The template includes `https://water1014.github.io` for the Pages preview and `https://localhost` for the Android Capacitor WebView (`androidScheme: https`). Never use `*`.

The filled `.env` is ignored by Git. Never paste its contents into chat, commit it, or include it in logs. Keep a secure offline copy of `COMPANION_TOKEN_PEPPER`; rotating it invalidates all existing device tokens and pairing codes.

### 3. Start PostgreSQL and apply migrations

```sh
docker compose up -d db
docker compose run --rm --entrypoint node api server/companion-sync/migrate.mjs
```

The migration runner applies the numbered SQL files in order and records successful migrations. The SQL files are idempotent, so an interrupted migration run can safely be retried.

### 4. Start the API and HTTPS proxy

```sh
docker compose up -d --build api caddy
docker compose ps
curl -fsS https://YOUR_SYNC_DOMAIN/v1/health
```

Caddy obtains and renews the HTTPS certificate automatically. The API is not published directly to the host, and PostgreSQL has no public port mapping.

### 5. Initialize the owner account

Load the environment into the current shell without printing it, then request the one-time pairing code:

```sh
set -a
. ./.env
set +a
curl -fsS -X POST "https://$COMPANION_DOMAIN/v1/admin/setup" \
  -H "X-Companion-Bootstrap-Token: $COMPANION_BOOTSTRAP_TOKEN"
unset COMPANION_BOOTSTRAP_TOKEN COMPANION_TOKEN_PEPPER POSTGRES_PASSWORD
```

The response contains a one-time pairing code. Save it privately; it expires after 10 minutes and is not shown again. Do not put it in a public issue, commit, screenshot or ordinary chat.

### 6. Pair the phone

1. Open SullyOS Settings → **宋祁 · 设备与同步**.
2. Enter the HTTPS service URL and the one-time pairing code.
3. Pairing creates a unique revocable token for this device. In the Android app it is stored through Android Keystore; browser preview storage is temporary.
4. Pairing alone does not upload notes. Explicitly enable **房间便签文字同步**, then press **立即同步**.
5. Verify the device list and test revocation before storing important data.

### 7. Backups and restore

Create encrypted off-host backups regularly. Install GnuPG on the VPS, restrict local file permissions, and encrypt the dump before it touches disk:

```sh
umask 077
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  | gzip \
  | gpg --symmetric --cipher-algo AES256 --output "companion-sync-$(date +%F).sql.gz.gpg"
```

GnuPG prompts for a backup passphrase. Keep that passphrase outside the VPS and separate from the database secrets. Copy only the encrypted file to off-host storage.

To test a restore, create a separate disposable database and decrypt directly into it:

```sh
docker compose exec -T db sh -c 'createdb -U "$POSTGRES_USER" companion_sync_restore_test'
gpg --decrypt companion-sync-YYYY-MM-DD.sql.gz.gpg | gunzip | \
  docker compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" companion_sync_restore_test'
```

Test restoring a backup before relying on it. A backup that has never been restored is only a hopeful file. Never store the only backup or its passphrase on the same VPS.

## Local development

Node.js 20+ and PostgreSQL 17+.

Environment variables:
- `DATABASE_URL`: PostgreSQL connection string. Never expose PostgreSQL publicly.
- `COMPANION_BOOTSTRAP_TOKEN`: random secret, at least 32 characters.
- `COMPANION_TOKEN_PEPPER`: independent random secret, at least 32 characters.
- `COMPANION_CORS_ORIGINS`: comma-separated exact browser origins allowed to call the API.
- `PORT`: optional, defaults to 8787.
- `PGSSLMODE=disable`: only for a private database network where TLS is intentionally terminated elsewhere.

Start with `pnpm start:companion-sync`. Apply migrations with `DATABASE_URL=...` and `node server/companion-sync/migrate.mjs`.

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
10. Keep PostgreSQL private, terminate TLS at Caddy, configure exact CORS origins, and verify backups before enabling sync.

## Release gate

Do not enable real sync until a disposable VPS deployment has passed health, pairing, opt-in, push/pull, opt-out cleanup, revocation, restart and backup-restore checks. The final APK must use the same package name and a permanently protected signing certificate for in-place updates to preserve app data. Do not publish a release APK until the signing key and update hosting are configured.
