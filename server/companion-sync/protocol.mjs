import { createHmac, timingSafeEqual } from 'node:crypto';

export const SYNC_ENTITY_TYPES = Object.freeze(['room_note']);
export const ROOM_NOTE_TYPES = Object.freeze(['lyric', 'doodle', 'thought', 'search', 'gossip']);

export function hashSecret(secret, pepper) {
  return createHmac('sha256', pepper).update(String(secret), 'utf8').digest();
}

export function safeEqualSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(actual, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function normalizeDeviceLabel(value) {
  if (typeof value !== 'string') throw new Error('INVALID_DEVICE_LABEL');
  const label = value.trim();
  if (!label || label.length > 24 || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new Error('INVALID_DEVICE_LABEL');
  }
  return label;
}

export function normalizePlatform(value) {
  const allowed = ['android', 'ios', 'web', 'desktop', 'unknown'];
  return allowed.includes(value) ? value : 'unknown';
}

export function validateSyncEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_EVENT');
  const { eventId, entityType, entityId, operation, baseVersion, clientVersion, clientCreatedAt, payload } = input;
  if (typeof eventId !== 'string' || !eventId.trim() || eventId.length > 160 || /[\u0000-\u001f]/.test(eventId)) {
    throw new Error('INVALID_EVENT_ID');
  }
  if (entityType !== 'room_note') throw new Error('UNSUPPORTED_ENTITY_TYPE');
  if (typeof entityId !== 'string' || !entityId.trim() || entityId.length > 256) throw new Error('INVALID_ENTITY_ID');
  if (!['create', 'update', 'delete'].includes(operation)) throw new Error('INVALID_OPERATION');
  if (baseVersion !== null && baseVersion !== undefined && (!Number.isSafeInteger(baseVersion) || baseVersion < 0)) {
    throw new Error('INVALID_BASE_VERSION');
  }
  if (!Number.isSafeInteger(clientVersion) || clientVersion < 1) throw new Error('INVALID_CLIENT_VERSION');
  if (!Number.isSafeInteger(clientCreatedAt) || clientCreatedAt < 0) throw new Error('INVALID_CLIENT_TIMESTAMP');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('INVALID_PAYLOAD');
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (bytes > 64 * 1024) throw new Error('PAYLOAD_TOO_LARGE');

  if (operation === 'delete') {
    if (Object.keys(payload).length !== 0) throw new Error('DELETE_EVENT_PAYLOAD_MUST_BE_EMPTY');
  } else {
    const allowed = ['id', 'charId', 'timestamp', 'content', 'type'];
    if (Object.keys(payload).some(key => !allowed.includes(key))) throw new Error('UNKNOWN_PAYLOAD_FIELD');
    if (payload.id !== entityId) throw new Error('PAYLOAD_ENTITY_ID_MISMATCH');
    if (typeof payload.charId !== 'string' || !payload.charId.trim() || payload.charId.length > 256) {
      throw new Error('INVALID_NOTE_CHARACTER_ID');
    }
    if (!Number.isSafeInteger(payload.timestamp) || payload.timestamp < 0) throw new Error('INVALID_NOTE_TIMESTAMP');
    if (typeof payload.content !== 'string' || payload.content.length > 20000) throw new Error('INVALID_NOTE_CONTENT');
    if (!ROOM_NOTE_TYPES.includes(payload.type)) throw new Error('INVALID_NOTE_TYPE');
  }
  return {
    eventId, entityType, entityId, operation,
    baseVersion: baseVersion ?? null,
    clientVersion, clientCreatedAt, payload,
  };
}

export function parseBearerToken(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9_-]{32,160})$/.exec(header);
  return match?.[1] ?? null;
}

export function parsePositiveInteger(value, fallback, max) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) throw Object.assign(new Error('INVALID_INTEGER_PARAMETER'), { status: 400 });
  return parsed;
}
