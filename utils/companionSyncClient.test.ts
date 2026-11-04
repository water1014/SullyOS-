import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    connection: null as null | { baseUrl: string; accountId: string; serverDeviceId: string; label: string },
    token: null as string | null,
    saved: [] as unknown[],
    removed: false,
    persistent: false,
}));
const store = vi.hoisted(() => ({
    getCompanionSyncConnection: vi.fn(async () => state.connection),
    getSyncPreference: vi.fn(async () => ({ enabled: false, mode: 'local_only' })),
    saveCompanionSyncConnection: vi.fn(async (value: unknown) => { state.saved.push(value); state.connection = value as typeof state.connection; }),
    removeCompanionSyncConnection: vi.fn(async () => { state.connection = null; }),
    getSyncCursorState: vi.fn(),
    listPendingSyncEvents: vi.fn(),
    listPendingInboxEvents: vi.fn(),
    persistInboxEvents: vi.fn(),
    applyPendingRoomNoteInboxEvent: vi.fn(),
    markInboxEventApplied: vi.fn(),
    removeSyncEvent: vi.fn(),
    setLocalRoomNoteServerVersion: vi.fn(),
    updateSyncCursorState: vi.fn(),
    updateSyncEventState: vi.fn(),
}));
const secure = vi.hoisted(() => ({
    secureStorageGet: vi.fn(async () => state.token),
    secureStoragePut: vi.fn(async (_key: string, value: string) => { state.token = value; }),
    secureStorageRemove: vi.fn(async () => { state.token = null; }),
    isPersistentSecureStorageAvailable: vi.fn(() => state.persistent),
}));

vi.mock('./localSyncStore', () => store);
vi.mock('./androidSecureStorage', () => secure);

import { pairCompanionDevice, syncCompanionOnce, setCompanionRemoteSyncPolicy, listCompanionDevices, revokeCompanionDevice } from './companionSyncClient';

describe('companion sync client pairing', () => {
    beforeEach(() => {
        state.connection = null;
        state.token = null;
        state.saved = [];
        state.removed = false;
        state.persistent = false;
        vi.clearAllMocks();
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
            expect(url).toBe('https://sync.example.test/v1/devices/pair');
            expect(init.method).toBe('POST');
            return new Response(JSON.stringify({
                accountId: 'account-1',
                deviceId: 'device-1',
                deviceToken: 'one-time-device-token',
                label: '主手机',
            }), { status: 201, headers: { 'content-type': 'application/json' } });
        }));
    });

    it('pairs once, stores the token through secure storage, and persists only non-secret metadata', async () => {
        const result = await pairCompanionDevice({
            baseUrl: 'https://sync.example.test/',
            pairingCode: 'one-time-code-123456789',
            label: '主手机',
        });
        expect(result).toEqual({
            accountId: 'account-1',
            deviceId: 'device-1',
            persistentTokenStorage: false,
        });
        expect(secure.secureStoragePut).toHaveBeenCalledWith('companion.device-token', 'one-time-device-token');
        expect(store.saveCompanionSyncConnection).toHaveBeenCalledWith({
            baseUrl: 'https://sync.example.test',
            accountId: 'account-1',
            serverDeviceId: 'device-1',
            label: '主手机',
        });
        expect(JSON.stringify(state.connection)).not.toContain('one-time-device-token');
    });

    it('rejects insecure non-local pairing endpoints before transmitting the one-time code', async () => {
        await expect(pairCompanionDevice({
            baseUrl: 'http://untrusted.example.test',
            pairingCode: 'one-time-code-123456789',
            label: '主手机',
        })).rejects.toThrow('INVALID_SYNC_BASE_URL');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('removes the newly issued token if saving local connection metadata fails', async () => {
        store.saveCompanionSyncConnection.mockRejectedValueOnce(new Error('IndexedDB unavailable'));
        await expect(pairCompanionDevice({
            baseUrl: 'https://sync.example.test',
            pairingCode: 'one-time-code-123456789',
            label: '主手机',
        })).rejects.toThrow('IndexedDB unavailable');
        expect(secure.secureStorageRemove).toHaveBeenCalled();
        expect(state.token).toBeNull();
    });

    it('rejects missing pairing codes before making a network request', async () => {
        await expect(pairCompanionDevice({
            baseUrl: 'https://sync.example.test',
            pairingCode: ' ',
            label: '主手机',
        })).rejects.toThrow('INVALID_PAIRING_CODE');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('refuses to contact the server unless local text sync consent is enabled', async () => {
        await expect(syncCompanionOnce()).rejects.toThrow('LOCAL_SYNC_CONSENT_REQUIRED');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('can disable remote sync only through the authenticated device token', async () => {
        state.connection = {
            baseUrl: 'https://sync.example.test',
            accountId: 'account-1',
            serverDeviceId: 'device-1',
            label: '主手机',
        };
        state.token = 'device-token';
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
            expect(new Headers(init.headers).get('authorization')).toBe('Bearer device-token');
            expect(JSON.parse(String(init.body))).toEqual({ entityType: 'room_note', enabled: false });
            return new Response(JSON.stringify({ enabled: false }), { status: 200 });
        }));
        const { setCompanionRemoteSyncPolicy } = await import('./companionSyncClient');
        await setCompanionRemoteSyncPolicy(false);
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});


describe('companion sync device management', () => {
    beforeEach(() => {
        state.connection = {
            baseUrl: 'https://sync.example.test',
            accountId: 'account-1',
            serverDeviceId: '11111111-1111-4111-8111-111111111111',
            label: '主手机',
        };
        state.token = 'device-token';
        vi.clearAllMocks();
    });

    it('lists paired devices using the authenticated current-device token', async () => {
        const devices = [{
            id: '11111111-1111-4111-8111-111111111111',
            label: '主手机',
            platform: 'android',
            appVersion: '1.0.0',
            createdAt: '2026-11-04T00:00:00.000Z',
            lastSeenAt: null,
            revokedAt: null,
        }];
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
            expect(url).toBe('https://sync.example.test/v1/devices');
            expect(new Headers(init.headers).get('authorization')).toBe('Bearer device-token');
            return new Response(JSON.stringify({ devices }), { status: 200 });
        }));
        await expect(listCompanionDevices()).resolves.toEqual(devices);
    });

    it('revokes only a valid other-device identifier through the authenticated API', async () => {
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
            expect(url).toBe('https://sync.example.test/v1/devices/22222222-2222-4222-8222-222222222222');
            expect(init.method).toBe('DELETE');
            expect(new Headers(init.headers).get('authorization')).toBe('Bearer device-token');
            return new Response(JSON.stringify({ revoked: true }), { status: 200 });
        }));
        await revokeCompanionDevice('22222222-2222-4222-8222-222222222222');
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('rejects malformed device IDs before making a request', async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        await expect(revokeCompanionDevice('not-a-device')).rejects.toThrow('INVALID_DEVICE_ID');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('never sends a stored device token to an insecure server URL', async () => {
        state.connection = {
            baseUrl: 'http://attacker.example.test',
            accountId: 'account-1',
            serverDeviceId: '11111111-1111-4111-8111-111111111111',
            label: '主手机',
        };
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        await expect(listCompanionDevices()).rejects.toThrow('INVALID_SYNC_BASE_URL');
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
