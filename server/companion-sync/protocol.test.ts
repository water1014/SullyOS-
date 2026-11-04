import { describe, expect, it } from 'vitest';
import {
  hashSecret,
  normalizeDeviceLabel,
  normalizePlatform,
  parseBearerToken,
  parsePositiveInteger,
  safeEqualSecret,
  validateSyncEvent,
} from './protocol.mjs';

const validEvent = {
  eventId: 'evt_test_001',
  entityType: 'room_note',
  entityId: 'note-1',
  operation: 'create',
  baseVersion: null,
  clientVersion: 1,
  clientCreatedAt: 1700000000000,
  payload: {
    id: 'note-1',
    charId: 'character-1',
    timestamp: 1700000000000,
    content: '一条普通便签',
    type: 'thought',
  },
};

describe('companion sync protocol', () => {
  it('hashes credentials with a pepper and compares admin tokens safely', () => {
    expect(hashSecret('secret', 'pepper')).toEqual(hashSecret('secret', 'pepper'));
    expect(hashSecret('secret', 'pepper')).not.toEqual(hashSecret('secret', 'another-pepper'));
    expect(safeEqualSecret('same-secret', 'same-secret')).toBe(true);
    expect(safeEqualSecret('same-secret', 'other-secret')).toBe(false);
    expect(safeEqualSecret(undefined, 'same-secret')).toBe(false);
  });

  it('validates bounded device labels and normalizes platform values', () => {
    expect(normalizeDeviceLabel('  我的手机  ')).toBe('我的手机');
    expect(() => normalizeDeviceLabel('')).toThrow('INVALID_DEVICE_LABEL');
    expect(() => normalizeDeviceLabel('x'.repeat(25))).toThrow('INVALID_DEVICE_LABEL');
    expect(() => normalizeDeviceLabel('phone\nadmin')).toThrow('INVALID_DEVICE_LABEL');
    expect(normalizePlatform('android')).toBe('android');
    expect(normalizePlatform('unexpected')).toBe('unknown');
  });

  it('accepts only the allowlisted room-note payload shape', () => {
    expect(validateSyncEvent(validEvent)).toEqual(validEvent);
    expect(() => validateSyncEvent({ ...validEvent, payload: { ...validEvent.payload, privateBlob: 'secret' } }))
      .toThrow('UNKNOWN_PAYLOAD_FIELD');
    expect(() => validateSyncEvent({ ...validEvent, payload: { ...validEvent.payload, id: 'another-note' } }))
      .toThrow('PAYLOAD_ENTITY_ID_MISMATCH');
    expect(() => validateSyncEvent({ ...validEvent, payload: { ...validEvent.payload, content: 'x'.repeat(20001) } }))
      .toThrow('INVALID_NOTE_CONTENT');
  });

  it('requires deletes to have empty payloads and a valid base version', () => {
    expect(validateSyncEvent({ ...validEvent, operation: 'delete', baseVersion: 1, payload: {} }).operation).toBe('delete');
    expect(() => validateSyncEvent({ ...validEvent, operation: 'delete', baseVersion: 1 }))
      .toThrow('DELETE_EVENT_PAYLOAD_MUST_BE_EMPTY');
    expect(() => validateSyncEvent({ ...validEvent, baseVersion: -1 })).toThrow('INVALID_BASE_VERSION');
  });

  it('parses bearer tokens and bounded integer parameters', () => {
    expect(parseBearerToken('Bearer ' + 'a'.repeat(43))).toBe('a'.repeat(43));
    expect(parseBearerToken('Bearer short')).toBeNull();
    expect(parseBearerToken('Basic abc')).toBeNull();
    expect(parsePositiveInteger('12', 0, 20)).toBe(12);
    expect(() => parsePositiveInteger('21', 0, 20)).toThrow('INVALID_INTEGER_PARAMETER');
    expect(() => parsePositiveInteger('-1', 0, 20)).toThrow('INVALID_INTEGER_PARAMETER');
  });
});
