import { Capacitor, registerPlugin } from '@capacitor/core';

interface SecureStoragePlugin {
    put(options: { key: string; value: string }): Promise<{ stored: boolean }>;
    get(options: { key: string }): Promise<{ value: string | null }>;
    remove(options: { key: string }): Promise<{ removed: boolean }>;
}

const NativeSecureStorage = registerPlugin<SecureStoragePlugin>('SecureStorage');

// Browser preview deliberately uses volatile memory only. A long-lived device
// bearer token must never silently fall back to localStorage or IndexedDB.
const volatileBrowserValues = new Map<string, string>();

function validateKey(key: string): void {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(key)) throw new Error('INVALID_SECURE_STORAGE_KEY');
}

export async function secureStoragePut(key: string, value: string): Promise<void> {
    validateKey(key);
    if (typeof value !== 'string' || value.length > 4096) throw new Error('INVALID_SECURE_STORAGE_VALUE');
    if (Capacitor.isNativePlatform()) {
        const result = await NativeSecureStorage.put({ key, value });
        if (!result?.stored) throw new Error('SECURE_STORAGE_WRITE_FAILED');
        return;
    }
    volatileBrowserValues.set(key, value);
}

export async function secureStorageGet(key: string): Promise<string | null> {
    validateKey(key);
    if (Capacitor.isNativePlatform()) {
        const result = await NativeSecureStorage.get({ key });
        return typeof result?.value === 'string' ? result.value : null;
    }
    return volatileBrowserValues.get(key) ?? null;
}

export async function secureStorageRemove(key: string): Promise<void> {
    validateKey(key);
    if (Capacitor.isNativePlatform()) {
        const result = await NativeSecureStorage.remove({ key });
        if (!result?.removed) throw new Error('SECURE_STORAGE_REMOVE_FAILED');
        return;
    }
    volatileBrowserValues.delete(key);
}

export function isPersistentSecureStorageAvailable(): boolean {
    return Capacitor.isNativePlatform();
}
