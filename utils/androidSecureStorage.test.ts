import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
    native: false,
    values: new Map<string, string>(),
}));
const nativePlugin = vi.hoisted(() => ({
    put: vi.fn(async ({ key, value }: { key: string; value: string }) => {
        mockState.values.set(key, value);
        return { stored: true };
    }),
    get: vi.fn(async ({ key }: { key: string }) => ({ value: mockState.values.get(key) ?? null })),
    remove: vi.fn(async ({ key }: { key: string }) => {
        mockState.values.delete(key);
        return { removed: true };
    }),
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => mockState.native },
    registerPlugin: () => nativePlugin,
}));

import {
    isPersistentSecureStorageAvailable,
    secureStorageGet,
    secureStoragePut,
    secureStorageRemove,
} from './androidSecureStorage';

describe('Android secure storage adapter', () => {
    beforeEach(() => {
        mockState.native = false;
        mockState.values.clear();
        nativePlugin.put.mockClear();
        nativePlugin.get.mockClear();
        nativePlugin.remove.mockClear();
    });

    it('uses volatile memory only in browser preview', async () => {
        expect(isPersistentSecureStorageAvailable()).toBe(false);
        await secureStoragePut('companion.device-token', 'short-lived-preview-token');
        expect(await secureStorageGet('companion.device-token')).toBe('short-lived-preview-token');
        expect(nativePlugin.put).not.toHaveBeenCalled();
        await secureStorageRemove('companion.device-token');
        expect(await secureStorageGet('companion.device-token')).toBeNull();
    });

    it('delegates persistence to the native Keystore plugin', async () => {
        mockState.native = true;
        expect(isPersistentSecureStorageAvailable()).toBe(true);
        await secureStoragePut('companion.device-token', 'native-token');
        expect(nativePlugin.put).toHaveBeenCalledWith({
            key: 'companion.device-token',
            value: 'native-token',
        });
        expect(await secureStorageGet('companion.device-token')).toBe('native-token');
        await secureStorageRemove('companion.device-token');
        expect(await secureStorageGet('companion.device-token')).toBeNull();
    });

    it('rejects invalid keys and oversized values before touching storage', async () => {
        await expect(secureStoragePut('../token', 'secret')).rejects.toThrow('INVALID_SECURE_STORAGE_KEY');
        await expect(secureStorageGet('')).rejects.toThrow('INVALID_SECURE_STORAGE_KEY');
        await expect(secureStoragePut('token', 'x'.repeat(4097))).rejects.toThrow('INVALID_SECURE_STORAGE_VALUE');
        expect(nativePlugin.put).not.toHaveBeenCalled();
    });

    it('does not fall back to browser memory when native storage fails', async () => {
        mockState.native = true;
        nativePlugin.put.mockRejectedValueOnce(new Error('Keystore unavailable'));
        await expect(secureStoragePut('companion.device-token', 'secret')).rejects.toThrow('Keystore unavailable');
        expect(nativePlugin.put).toHaveBeenCalledTimes(1);
    });
});
