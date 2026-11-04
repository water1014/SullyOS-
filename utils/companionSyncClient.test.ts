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

import { pairCompanionDevice, syncCompanionOnce, setCompanionRemoteSyncPolicy } from './companionSyncClient';

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
