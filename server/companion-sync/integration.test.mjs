import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for the companion sync integration test');

const port = Number(process.env.COMPANION_SYNC_TEST_PORT || 18878);
const baseUrl = `http://127.0.0.1:${port}`;
const bootstrapToken = 'test-bootstrap-token-'.padEnd(48, 'x');
const pepper = 'test-token-pepper-'.padEnd(48, 'y');
const origin = 'https://sullyos.example.test';
const pool = new Pool({ connectionString: databaseUrl, ssl: false });

let child;
let childOutput = '';
const assertStatus = (response, status, label) => {
  assert.equal(response.status, status, `${label}: expected HTTP ${status}, received ${response.status}; body=${JSON.stringify(response.body)}`);
};

async function request(path, { method = 'GET', token, body, admin = false, headers = {} } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(admin ? { 'x-companion-bootstrap-token': bootstrapToken } : {}),
      origin,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  return { status: response.status, body: parsed, headers: response.headers };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`companion-sync exited early: ${childOutput}`);
    try {
      const response = await fetch(baseUrl + '/v1/health');
      if (response.ok) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`companion-sync did not become healthy: ${childOutput}`);
}

async function main() {
  for (const migration of [
    '0001_initial.sql',
    '0002_pairing_and_delivery.sql',
    '0003_account_sequence_watermark.sql',
  ]) {
    const sql = await readFile(new URL(`./migrations/${migration}`, import.meta.url), 'utf8');
    await pool.query(sql);
  }

  child = spawn(process.execPath, ['server/companion-sync/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PGSSLMODE: 'disable',
      COMPANION_BOOTSTRAP_TOKEN: bootstrapToken,
      COMPANION_TOKEN_PEPPER: pepper,
      COMPANION_CORS_ORIGINS: origin,
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { childOutput += chunk.toString(); });
  child.stderr.on('data', chunk => { childOutput += chunk.toString(); });
  await waitForServer();

  const wrongAdmin = await request('/v1/admin/setup', { method: 'POST', admin: false });
  assertStatus(wrongAdmin, 401, 'bootstrap token required');

  const setup = await request('/v1/admin/setup', { method: 'POST', admin: true });
  assertStatus(setup, 201, 'initialize owner');
  assert.equal(typeof setup.body.pairingCode, 'string');

  const firstPair = await request('/v1/devices/pair', {
    method: 'POST',
    body: { code: setup.body.pairingCode, label: '主手机', platform: 'android', appVersion: 'test' },
  });
  assertStatus(firstPair, 201, 'pair first device');
  const deviceOne = firstPair.body.deviceToken;

  const replayPair = await request('/v1/devices/pair', {
    method: 'POST',
    body: { code: setup.body.pairingCode, label: '重复设备', platform: 'android' },
  });
  assertStatus(replayPair, 401, 'pairing code is one-time');

  const invalidLabelCode = await request('/v1/admin/pairing-codes', { method: 'POST', admin: true });
  assertStatus(invalidLabelCode, 201, 'issue invalid-label test code');
  const invalidLabel = await request('/v1/devices/pair', {
    method: 'POST',
    body: { code: invalidLabelCode.body.pairingCode, label: '', platform: 'android' },
  });
  assertStatus(invalidLabel, 400, 'reject invalid device label');

  const nextCode = await request('/v1/admin/pairing-codes', { method: 'POST', admin: true });
  assertStatus(nextCode, 201, 'issue second pairing code');
  const secondPair = await request('/v1/devices/pair', {
    method: 'POST',
    body: { code: nextCode.body.pairingCode, label: '备用手机', platform: 'android' },
  });
  assertStatus(secondPair, 201, 'pair second device');
  const deviceTwo = secondPair.body.deviceToken;

  const policy = await request('/v1/sync/policy', {
    method: 'POST', token: deviceOne, body: { entityType: 'room_note', enabled: true },
  });
  assertStatus(policy, 200, 'explicitly enable text sync');

  const createEvent = {
    eventId: 'evt_integration_create',
    entityType: 'room_note',
    entityId: 'note-integration-1',
    operation: 'create',
    baseVersion: null,
    clientVersion: 1,
    clientCreatedAt: Date.now(),
    payload: {
      id: 'note-integration-1',
      charId: 'character-1',
      timestamp: Date.now(),
      content: '仅用于自动化测试的普通便签',
      type: 'thought',
    },
  };
  const pushed = await request('/v1/sync/push', { method: 'POST', token: deviceOne, body: { events: [createEvent] } });
  assertStatus(pushed, 200, 'push create event');
  assert.equal(pushed.body.outcomes[0].status, 'accepted');
  const sequenceOne = pushed.body.outcomes[0].serverSequence;

  const duplicate = await request('/v1/sync/push', { method: 'POST', token: deviceOne, body: { events: [createEvent] } });
  assertStatus(duplicate, 200, 'idempotent retry');
  assert.equal(duplicate.body.outcomes[0].status, 'duplicate');
  assert.equal(duplicate.body.outcomes[0].serverSequence, sequenceOne);

  const collision = await request('/v1/sync/push', {
    method: 'POST', token: deviceOne,
    body: { events: [{ ...createEvent, payload: { ...createEvent.payload, content: '不同内容' } }] },
  });
  assertStatus(collision, 200, 'event id collision response');
  assert.equal(collision.body.outcomes[0].status, 'rejected');
  assert.equal(collision.body.outcomes[0].error, 'EVENT_ID_COLLISION');

  const invalidCursor = await request('/v1/sync/pull?cursor=not-a-number', { token: deviceTwo });
  assertStatus(invalidCursor, 400, 'reject malformed pull cursor');

  const pulled = await request('/v1/sync/pull?cursor=0&limit=50', { token: deviceTwo });
  assertStatus(pulled, 200, 'pull from second device');
  assert.equal(pulled.body.events.length, 1);
  assert.equal(pulled.body.events[0].payload.content, createEvent.payload.content);

  const forgedAck = await request('/v1/sync/ack', {
    method: 'POST', token: deviceTwo, body: { lastAckedSequence: sequenceOne + 1 },
  });
  assertStatus(forgedAck, 409, 'ack cannot exceed delivered events');

  const ackOne = await request('/v1/sync/ack', {
    method: 'POST', token: deviceTwo, body: { lastAckedSequence: sequenceOne },
  });
  assertStatus(ackOne, 200, 'ack delivered event');

  const conflictingCreate = await request('/v1/sync/push', {
    method: 'POST', token: deviceTwo,
    body: { events: [{ ...createEvent, eventId: 'evt_integration_conflict', clientCreatedAt: Date.now() }] },
  });
  assertStatus(conflictingCreate, 200, 'concurrent create conflict');
  assert.equal(conflictingCreate.body.outcomes[0].status, 'conflict');

  const updateEvent = {
    ...createEvent,
    eventId: 'evt_integration_update',
    operation: 'update',
    baseVersion: 1,
    clientVersion: 2,
    clientCreatedAt: Date.now(),
    payload: { ...createEvent.payload, content: '更新后的便签内容' },
  };
  const updated = await request('/v1/sync/push', { method: 'POST', token: deviceOne, body: { events: [updateEvent] } });
  assertStatus(updated, 200, 'push update');
  assert.equal(updated.body.outcomes[0].status, 'accepted');
  const sequenceTwo = updated.body.outcomes[0].serverSequence;

  const pulledUpdate = await request(`/v1/sync/pull?cursor=${sequenceOne}&limit=50`, { token: deviceTwo });
  assertStatus(pulledUpdate, 200, 'pull update');
  assert.equal(pulledUpdate.body.events.length, 1);
  assert.equal(pulledUpdate.body.events[0].payload.content, '更新后的便签内容');

  const ackTwo = await request('/v1/sync/ack', {
    method: 'POST', token: deviceTwo, body: { lastAckedSequence: sequenceTwo },
  });
  assertStatus(ackTwo, 200, 'ack update');

  const devices = await request('/v1/devices', { token: deviceOne });
  assertStatus(devices, 200, 'list devices');
  assert.equal(devices.body.devices.length, 2);
  const revoke = await request(`/v1/devices/${secondPair.body.deviceId}`, { method: 'DELETE', token: deviceOne });
  assertStatus(revoke, 200, 'revoke second device');
  const revokedAccess = await request('/v1/devices', { token: deviceTwo });
  assertStatus(revokedAccess, 401, 'revoked device cannot authenticate');

  const disable = await request('/v1/sync/policy', {
    method: 'POST', token: deviceOne, body: { entityType: 'room_note', enabled: false },
  });
  assertStatus(disable, 200, 'disable sync');
  // The account is discovered from the authenticated device row, never trusted from the client.
  const account = await pool.query('SELECT account_id FROM companion_devices WHERE id = $1', [firstPair.body.deviceId]);
  const remaining = await pool.query('SELECT count(*)::int AS count FROM companion_sync_events WHERE account_id = $1', [account.rows[0].account_id]);
  assert.equal(remaining.rows[0].count, 0);

  const watermarkPull = await request(`/v1/sync/pull?cursor=${sequenceTwo}&limit=50`, { token: deviceOne });
  assertStatus(watermarkPull, 200, 'account watermark survives opt-out');
  assert.equal(watermarkPull.body.events.length, 0);
  const cursorAhead = await request(`/v1/sync/pull?cursor=${sequenceTwo + 1}&limit=50`, { token: deviceOne });
  assertStatus(cursorAhead, 409, 'reject cursor beyond account watermark');

  const selfRevoke = await request(`/v1/devices/${firstPair.body.deviceId}`, { method: 'DELETE', token: deviceOne });
  assertStatus(selfRevoke, 409, 'cannot revoke current device');

  const forbiddenOrigin = await fetch(baseUrl + '/v1/health', { headers: { origin: 'https://not-allowed.example.test' } });
  assert.equal(forbiddenOrigin.status, 403);

  process.stdout.write('Companion sync PostgreSQL integration test passed.\n');
}

try {
  await main();
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      delay(5000),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await pool.end();
}
