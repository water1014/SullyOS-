import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import {
  hashSecret,
  normalizeDeviceLabel,
  normalizePlatform,
  parseBearerToken,
  parsePositiveInteger,
  safeEqualSecret,
  validateSyncEvent,
} from './protocol.mjs';

const { Pool } = pg;
const PORT = Number(process.env.PORT || 8787);
const DATABASE_URL = process.env.DATABASE_URL;
const BOOTSTRAP_TOKEN = process.env.COMPANION_BOOTSTRAP_TOKEN;
const TOKEN_PEPPER = process.env.COMPANION_TOKEN_PEPPER;
const CORS_ORIGINS = new Set((process.env.COMPANION_CORS_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean));
const BODY_LIMIT = 1024 * 1024;

if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!BOOTSTRAP_TOKEN || BOOTSTRAP_TOKEN.length < 32) throw new Error('COMPANION_BOOTSTRAP_TOKEN must be at least 32 characters');
if (!TOKEN_PEPPER || TOKEN_PEPPER.length < 32) throw new Error('COMPANION_TOKEN_PEPPER must be at least 32 characters');

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false' },
});

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!CORS_ORIGINS.has(origin)) return false;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'Origin');
  res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'Authorization,Content-Type');
  res.setHeader('access-control-max-age', '600');
  return true;
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw Object.assign(new Error('BODY_TOO_LARGE'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw Object.assign(new Error('INVALID_JSON'), { status: 400 });
  }
}

function requireAdmin(req) {
  const supplied = req.headers['x-companion-bootstrap-token'];
  if (!safeEqualSecret(supplied, BOOTSTRAP_TOKEN)) {
    throw Object.assign(new Error('UNAUTHORIZED'), { status: 401 });
  }
}

async function authenticate(req) {
  const token = parseBearerToken(req.headers.authorization);
  if (!token) throw Object.assign(new Error('UNAUTHORIZED'), { status: 401 });
  const tokenHash = hashSecret(token, TOKEN_PEPPER);
  const result = await pool.query(
    `SELECT d.id AS device_id, d.account_id, d.label, a.status AS account_status
       FROM companion_devices d
       JOIN companion_accounts a ON a.id = d.account_id
      WHERE d.token_hash = $1 AND d.revoked_at IS NULL
      LIMIT 1`,
    [tokenHash],
  );
  const device = result.rows[0];
  if (!device || device.account_status !== 'active') {
    throw Object.assign(new Error('UNAUTHORIZED'), { status: 401 });
  }
  void pool.query('UPDATE companion_devices SET last_seen_at = now() WHERE id = $1', [device.device_id]).catch(() => {});
  return device;
}

function makePairingCode() {
  return randomBytes(24).toString('base64url');
}

async function storePairingCode(client, accountId) {
  const code = makePairingCode();
  await client.query(
    'INSERT INTO companion_pairing_codes (code_hash, account_id, expires_at) VALUES ($1, $2, now() + interval \'10 minutes\')',
    [hashSecret(code, TOKEN_PEPPER), accountId],
  );
  return code;
}

async function adminSetup() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('companion-sync-owner-setup'))");
    const existing = await client.query('SELECT id FROM companion_accounts LIMIT 1');
    if (existing.rowCount) {
      await client.query('ROLLBACK');
      return { status: 409, body: { error: 'ACCOUNT_ALREADY_INITIALIZED' } };
    }
    const account = await client.query(
      "INSERT INTO companion_accounts (auth_subject) VALUES ('single-owner') RETURNING id",
    );
    const code = await storePairingCode(client, account.rows[0].id);
    await client.query('COMMIT');
    return { status: 201, body: { pairingCode: code, expiresInSeconds: 600, message: 'Save this one-time code. It will not be shown again.' } };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function createPairingCode() {
  const result = await pool.query("SELECT id FROM companion_accounts WHERE status = 'active' ORDER BY created_at LIMIT 1");
  if (!result.rowCount) return { status: 409, body: { error: 'ACCOUNT_NOT_INITIALIZED' } };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const code = await storePairingCode(client, result.rows[0].id);
    await client.query('COMMIT');
    return { status: 201, body: { pairingCode: code, expiresInSeconds: 600 } };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function pairDevice(body) {
  if (typeof body.code !== 'string' || body.code.length < 24 || body.code.length > 128) {
    return { status: 400, body: { error: 'INVALID_PAIRING_CODE' } };
  }
  const label = normalizeDeviceLabel(body.label);
  const platform = normalizePlatform(body.platform);
  const appVersion = typeof body.appVersion === 'string' ? body.appVersion.slice(0, 64) : null;
  const token = randomBytes(32).toString('base64url');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const code = await client.query(
      `SELECT account_id, expires_at, used_at FROM companion_pairing_codes
        WHERE code_hash = $1 FOR UPDATE`,
      [hashSecret(body.code, TOKEN_PEPPER)],
    );
    const row = code.rows[0];
    if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now()) {
      await client.query('ROLLBACK');
      return { status: 401, body: { error: 'PAIRING_CODE_INVALID_OR_EXPIRED' } };
    }
    const device = await client.query(
      `INSERT INTO companion_devices (account_id, label, platform, app_version, token_hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [row.account_id, label, platform, appVersion, hashSecret(token, TOKEN_PEPPER)],
    );
    await client.query('UPDATE companion_pairing_codes SET used_at = now() WHERE code_hash = $1', [hashSecret(body.code, TOKEN_PEPPER)]);
    await client.query('COMMIT');
    return { status: 201, body: { deviceId: device.rows[0].id, deviceToken: token, label } };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function pushEvents(device, events) {
  if (!Array.isArray(events) || events.length < 1 || events.length > 50) {
    return { status: 400, body: { error: 'INVALID_EVENT_BATCH' } };
  }
  const outcomes = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const policy = await client.query(
      "SELECT enabled, mode FROM companion_sync_policies WHERE account_id = $1 AND entity_type = 'room_note' FOR SHARE",
      [device.account_id],
    );
    if (!policy.rows[0]?.enabled || policy.rows[0]?.mode !== 'text') {
      await client.query('ROLLBACK');
      return { status: 403, body: { error: 'SYNC_NOT_ENABLED' } };
    }

    for (const raw of events) {
      let event;
      try { event = validateSyncEvent(raw); }
      catch (error) {
        outcomes.push({ eventId: typeof raw?.eventId === 'string' ? raw.eventId.slice(0, 160) : null, status: 'rejected', error: error.message });
        continue;
      }
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`${device.account_id}:event:${event.eventId}`],
      );
      const existing = await client.query(
        'SELECT server_sequence, entity_version FROM companion_sync_events WHERE account_id = $1 AND event_id = $2',
        [device.account_id, event.eventId],
      );
      if (existing.rowCount) {
        outcomes.push({ eventId: event.eventId, status: 'duplicate', serverSequence: Number(existing.rows[0].server_sequence), entityVersion: Number(existing.rows[0].entity_version) });
        continue;
      }
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`${device.account_id}:${event.entityType}:${event.entityId}`],
      );
      const head = await client.query(
        `SELECT current_version, deleted_at FROM companion_sync_entity_heads
          WHERE account_id = $1 AND entity_type = $2 AND entity_id = $3 FOR UPDATE`,
        [device.account_id, event.entityType, event.entityId],
      );
      const currentVersion = head.rowCount ? Number(head.rows[0].current_version) : 0;
      const validBase = event.baseVersion === null
        ? currentVersion === 0 && event.operation === 'create'
        : event.baseVersion === currentVersion && currentVersion > 0;
      if (!validBase || (head.rowCount && head.rows[0].deleted_at && event.operation !== 'create')) {
        outcomes.push({ eventId: event.eventId, status: 'conflict', currentVersion });
        continue;
      }
      const entityVersion = currentVersion + 1;
      const inserted = await client.query(
        `INSERT INTO companion_sync_events
          (event_id, account_id, device_id, entity_type, entity_id, operation, base_version, entity_version, payload, client_created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,to_timestamp($10 / 1000.0))
         RETURNING server_sequence`,
        [event.eventId, device.account_id, device.device_id, event.entityType, event.entityId, event.operation,
          event.baseVersion ?? 0, entityVersion, JSON.stringify(event.payload), event.clientCreatedAt],
      );
      await client.query(
        `INSERT INTO companion_sync_entity_heads
          (account_id, entity_type, entity_id, current_version, last_event_id, deleted_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,CASE WHEN $6 = 'delete' THEN now() ELSE NULL END,now())
         ON CONFLICT (account_id, entity_type, entity_id) DO UPDATE SET
           current_version = EXCLUDED.current_version,
           last_event_id = EXCLUDED.last_event_id,
           deleted_at = EXCLUDED.deleted_at,
           updated_at = now()`,
        [device.account_id, event.entityType, event.entityId, entityVersion, event.eventId, event.operation],
      );
      outcomes.push({ eventId: event.eventId, status: 'accepted', serverSequence: Number(inserted.rows[0].server_sequence), entityVersion });
    }
    await client.query('COMMIT');
    return { status: 200, body: { outcomes } };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function pullEvents(device, url) {
  const cursor = parsePositiveInteger(url.searchParams.get('cursor'), 0, Number.MAX_SAFE_INTEGER);
  const limit = Math.min(100, Math.max(1, parsePositiveInteger(url.searchParams.get('limit'), 50, 100)));
  const highest = await pool.query(
    'SELECT COALESCE(MAX(server_sequence), 0) AS max_sequence FROM companion_sync_events WHERE account_id = $1',
    [device.account_id],
  );
  const maxSequence = Number(highest.rows[0].max_sequence);
  if (cursor > maxSequence) return { status: 409, body: { error: 'CURSOR_AHEAD_OF_SERVER', maxSequence } };
  const result = await pool.query(
    `SELECT e.event_id, e.server_sequence, e.entity_type, e.entity_id, e.operation,
            e.entity_version, e.payload, e.received_at
       FROM companion_sync_events e
      WHERE e.account_id = $1 AND e.server_sequence > $2
        AND EXISTS (
          SELECT 1 FROM companion_sync_policies p
           WHERE p.account_id = e.account_id AND p.entity_type = e.entity_type
             AND p.enabled = TRUE AND p.mode = 'text'
        )
      ORDER BY e.server_sequence ASC LIMIT $3`,
    [device.account_id, cursor, limit],
  );
  const events = result.rows.map(row => ({
    eventId: row.event_id,
    serverSequence: Number(row.server_sequence),
    entityType: row.entity_type,
    entityId: row.entity_id,
    operation: row.operation,
    entityVersion: Number(row.entity_version),
    payload: row.payload,
  }));
  const maxDelivered = events.reduce((max, event) => Math.max(max, event.serverSequence), cursor);
  await pool.query(
    `INSERT INTO companion_device_deliveries (account_id, device_id, max_delivered_sequence)
     VALUES ($1,$2,$3)
     ON CONFLICT (account_id, device_id) DO UPDATE SET
       max_delivered_sequence = GREATEST(companion_device_deliveries.max_delivered_sequence, EXCLUDED.max_delivered_sequence),
       updated_at = now()`,
    [device.account_id, device.device_id, maxDelivered],
  );
  return { status: 200, body: { events, nextCursor: events.length ? events[events.length - 1].serverSequence : cursor } };
}

async function ackEvents(device, body) {
  const sequence = parsePositiveInteger(body.lastAckedSequence, null, Number.MAX_SAFE_INTEGER);
  if (sequence === null) return { status: 400, body: { error: 'INVALID_ACK_SEQUENCE' } };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const delivery = await client.query(
      'SELECT max_delivered_sequence FROM companion_device_deliveries WHERE account_id = $1 AND device_id = $2 FOR UPDATE',
      [device.account_id, device.device_id],
    );
    const maxDelivered = delivery.rowCount ? Number(delivery.rows[0].max_delivered_sequence) : 0;
    if (sequence > maxDelivered) {
      await client.query('ROLLBACK');
      return { status: 409, body: { error: 'ACK_EXCEEDS_DELIVERED_CURSOR', maxDeliveredSequence: maxDelivered } };
    }
    await client.query(
      `INSERT INTO companion_device_cursors (account_id, device_id, last_acked_sequence)
       VALUES ($1,$2,$3)
       ON CONFLICT (account_id, device_id) DO UPDATE SET
         last_acked_sequence = GREATEST(companion_device_cursors.last_acked_sequence, EXCLUDED.last_acked_sequence),
         updated_at = now()`,
      [device.account_id, device.device_id, sequence],
    );
    await client.query('COMMIT');
    return { status: 200, body: { lastAckedSequence: sequence } };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function handle(req, res) {
  if (!applyCors(req, res)) return json(res, 403, { error: 'ORIGIN_NOT_ALLOWED' });
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/v1/health' && req.method === 'GET') {
    try {
      await pool.query('SELECT 1');
      return json(res, 200, { ok: true, service: 'companion-sync', database: 'ready' });
    } catch {
      return json(res, 503, { ok: false, service: 'companion-sync', database: 'unavailable' });
    }
  }
  try {
    if (url.pathname === '/v1/admin/setup' && req.method === 'POST') {
      requireAdmin(req);
      const result = await adminSetup();
      return json(res, result.status, result.body);
    }
    if (url.pathname === '/v1/admin/pairing-codes' && req.method === 'POST') {
      requireAdmin(req);
      const result = await createPairingCode();
      return json(res, result.status, result.body);
    }
    if (url.pathname === '/v1/devices/pair' && req.method === 'POST') {
      const result = await pairDevice(await readJson(req));
      return json(res, result.status, result.body);
    }

    const device = await authenticate(req);
    if (url.pathname === '/v1/devices' && req.method === 'GET') {
      const result = await pool.query(
        `SELECT id, label, platform, app_version AS "appVersion", created_at AS "createdAt",
                last_seen_at AS "lastSeenAt", revoked_at AS "revokedAt"
           FROM companion_devices WHERE account_id = $1 ORDER BY created_at DESC`,
        [device.account_id],
      );
      return json(res, 200, { devices: result.rows });
    }
    const revoke = /^\/v1\/devices\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (revoke && req.method === 'DELETE') {
      if (revoke[1] === device.device_id) return json(res, 409, { error: 'CANNOT_REVOKE_CURRENT_DEVICE' });
      const result = await pool.query(
        `UPDATE companion_devices SET revoked_at = now()
          WHERE account_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING id`,
        [device.account_id, revoke[1]],
      );
      return json(res, result.rowCount ? 200 : 404, result.rowCount ? { revoked: true } : { error: 'DEVICE_NOT_FOUND' });
    }
    if (url.pathname === '/v1/sync/policy' && req.method === 'POST') {
      const body = await readJson(req);
      if (body.entityType !== 'room_note' || typeof body.enabled !== 'boolean') return json(res, 400, { error: 'INVALID_SYNC_POLICY' });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO companion_sync_policies (account_id, entity_type, enabled, mode)
           VALUES ($1,'room_note',$2,CASE WHEN $2 THEN 'text' ELSE 'local_only' END)
           ON CONFLICT (account_id, entity_type) DO UPDATE SET
             enabled = EXCLUDED.enabled, mode = EXCLUDED.mode, updated_at = now()`,
          [device.account_id, body.enabled],
        );
        if (!body.enabled) {
          // Explicit opt-out also removes server-side text replicas and transport metadata.
          await client.query("DELETE FROM companion_sync_events WHERE account_id = $1 AND entity_type = 'room_note'", [device.account_id]);
          await client.query("DELETE FROM companion_sync_entity_heads WHERE account_id = $1 AND entity_type = 'room_note'", [device.account_id]);
          await client.query('DELETE FROM companion_device_cursors WHERE account_id = $1', [device.account_id]);
          await client.query('DELETE FROM companion_device_deliveries WHERE account_id = $1', [device.account_id]);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      return json(res, 200, { entityType: 'room_note', enabled: body.enabled, mode: body.enabled ? 'text' : 'local_only' });
    }
    if (url.pathname === '/v1/sync/push' && req.method === 'POST') {
      const body = await readJson(req);
      const result = await pushEvents(device, body.events);
      return json(res, result.status, result.body);
    }
    if (url.pathname === '/v1/sync/pull' && req.method === 'GET') {
      const result = await pullEvents(device, url);
      return json(res, result.status, result.body);
    }
    if (url.pathname === '/v1/sync/ack' && req.method === 'POST') {
      const result = await ackEvents(device, await readJson(req));
      return json(res, result.status, result.body);
    }
    return json(res, 404, { error: 'NOT_FOUND' });
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    if (status >= 500) {
      // Never log request headers, tokens, payloads, or database parameters.
      process.stderr.write(`companion-sync error: ${String(error?.code || error?.name || 'INTERNAL_ERROR')}\n`);
    }
    return json(res, status, { error: status >= 500 ? 'INTERNAL_ERROR' : error.message });
  }
}

const server = createServer((req, res) => { void handle(req, res); });
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`companion-sync listening on ${PORT}\n`);
});

async function shutdown(signal) {
  process.stdout.write(`companion-sync shutting down (${signal})\n`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
