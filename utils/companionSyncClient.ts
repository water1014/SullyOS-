import {
    getCompanionSyncConnection,
    getSyncPreference,
    getSyncCursorState,
    listPendingSyncEvents,
    listPendingInboxEvents,
    persistInboxEvents,
    applyPendingRoomNoteInboxEvent,
    markInboxEventApplied,
    removeSyncEvent,
    setLocalRoomNoteServerVersion,
    updateSyncCursorState,
    updateSyncEventState,
    saveCompanionSyncConnection,
    removeCompanionSyncConnection,
    type LocalSyncEvent,
} from './localSyncStore';
import { secureStorageGet, secureStoragePut, secureStorageRemove, isPersistentSecureStorageAvailable } from './androidSecureStorage';

const TOKEN_KEY = 'companion.device-token';
const REQUEST_TIMEOUT_MS = 15000;

interface PairResponse {
    accountId: string;
    deviceId: string;
    deviceToken: string;
    label: string;
}

interface ApiErrorBody { error?: string }

async function requestJson<T>(
    baseUrl: string,
    path: string,
    options: { method?: string; token?: string; body?: unknown } = {},
): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
            method: options.method ?? 'GET',
            headers: {
                ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
                ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
            },
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            signal: controller.signal,
            cache: 'no-store',
        });
        const body = await response.json().catch(() => ({})) as T & ApiErrorBody;
        if (!response.ok) throw new Error(body.error || `HTTP_${response.status}`);
        return body;
    } finally {
        clearTimeout(timeout);
    }
}

export async function pairCompanionDevice(input: {
    baseUrl: string;
    pairingCode: string;
    label: string;
    appVersion?: string;
}): Promise<{ accountId: string; deviceId: string; persistentTokenStorage: boolean }> {
    const baseUrl = input.baseUrl.trim().replace(/\/$/, '');
    const code = input.pairingCode.trim();
    if (!code || code.length > 128) throw new Error('INVALID_PAIRING_CODE');
    const paired = await requestJson<PairResponse>(baseUrl, '/v1/devices/pair', {
        method: 'POST',
        body: {
            code,
            label: input.label.trim(),
            platform: 'android',
            appVersion: input.appVersion ?? '1.0.0',
        },
    });
    if (!paired.accountId || !paired.deviceId || !paired.deviceToken) throw new Error('INVALID_PAIR_RESPONSE');

    // Store token before connection metadata. If either operation fails, remove
    // the token so we never leave an untracked credential behind.
    try {
        await secureStoragePut(TOKEN_KEY, paired.deviceToken);
        await saveCompanionSyncConnection({
            baseUrl,
            accountId: paired.accountId,
            serverDeviceId: paired.deviceId,
            label: paired.label || input.label.trim(),
        });
    } catch (error) {
        await secureStorageRemove(TOKEN_KEY).catch(() => {});
        throw error;
    }
    return {
        accountId: paired.accountId,
        deviceId: paired.deviceId,
        persistentTokenStorage: isPersistentSecureStorageAvailable(),
    };
}

export async function disconnectCompanionDevice(revokeOnServer = true): Promise<void> {
    const [connection, token] = await Promise.all([
        getCompanionSyncConnection(),
        secureStorageGet(TOKEN_KEY),
    ]);
    if (revokeOnServer && connection && token) {
        await requestJson(connection.baseUrl, '/v1/devices/current/revoke', { method: 'POST', token });
    }
    await secureStorageRemove(TOKEN_KEY);
    await removeCompanionSyncConnection();
}

async function pushPending(baseUrl: string, token: string): Promise<number> {
    const events = await listPendingSyncEvents(50);
    if (!events.length) return 0;
    const prepared: LocalSyncEvent[] = [];
    for (const event of events) {
        await updateSyncEventState(event.eventId, 'in_flight');
        prepared.push(event);
    }
    try {
        const result = await requestJson<{
            outcomes: Array<{
                eventId: string;
                status: 'accepted' | 'duplicate' | 'conflict' | 'rejected';
                entityVersion?: number;
                error?: string;
            }>;
        }>(baseUrl, '/v1/sync/push', {
            method: 'POST',
            token,
            body: { events: prepared.map(({ eventId, entityType, entityId, operation, baseVersion, clientVersion, clientCreatedAt, payload }) => ({
                eventId, entityType, entityId, operation, baseVersion, clientVersion, clientCreatedAt, payload,
            })) },
        });
        const outcomes = new Map(result.outcomes.map(outcome => [outcome.eventId, outcome]));
        let completed = 0;
        for (const event of prepared) {
            const outcome = outcomes.get(event.eventId);
            if (!outcome) {
                await updateSyncEventState(event.eventId, 'pending', 'MISSING_SERVER_OUTCOME');
                continue;
            }
            if (outcome.status === 'accepted' || outcome.status === 'duplicate') {
                if (Number.isSafeInteger(outcome.entityVersion) && Number(outcome.entityVersion) > 0) {
                    await setLocalRoomNoteServerVersion(event.entityId, Number(outcome.entityVersion));
                }
                await removeSyncEvent(event.eventId);
                completed += 1;
            } else {
                await updateSyncEventState(event.eventId, 'blocked', outcome.error || (outcome.status === 'conflict' ? 'VERSION_CONFLICT' : 'SERVER_REJECTED'));
            }
        }
        return completed;
    } catch (error) {
        for (const event of prepared) {
            await updateSyncEventState(event.eventId, 'pending', 'NETWORK_OR_SERVER_ERROR').catch(() => {});
        }
        throw error;
    }
}

async function pullAndApply(
    baseUrl: string,
    token: string,
    accountId: string,
    deviceId: string,
): Promise<{ received: number; applied: number; conflicts: number; blocked: number }> {
    const cursor = await getSyncCursorState(accountId, deviceId);
    const result = await requestJson<{
        events: Array<{
            eventId: string; serverSequence: number; entityType: 'room_note';
            entityId: string; operation: 'create' | 'update' | 'delete';
            entityVersion: number; payload: Record<string, unknown>;
        }>;
        nextCursor: number;
    }>(baseUrl, `/v1/sync/pull?cursor=${cursor.lastPulledSequence}&limit=100`, { token });

    await persistInboxEvents(result.events);
    let applied = 0;
    let conflicts = 0;
    let blocked = 0;
    const pending = await listPendingInboxEvents(100);
    for (const event of pending) {
        const outcome = await applyPendingRoomNoteInboxEvent(event.eventId);
        if (outcome.status === 'applied') {
            await markInboxEventApplied(event.eventId);
            if (event.operation === 'delete') {
                // The server version is retained as a tombstone watermark so a
                // stale local create cannot silently resurrect a deleted note.
                await setLocalRoomNoteServerVersion(event.entityId, event.entityVersion);
            } else {
                await setLocalRoomNoteServerVersion(event.entityId, event.entityVersion);
            }
            applied += 1;
        } else if (outcome.status === 'conflict') {
            conflicts += 1;
        } else {
            blocked += 1;
        }
    }

    if (result.events.length) {
        const delivered = result.events[result.events.length - 1].serverSequence;
        await requestJson(baseUrl, '/v1/sync/ack', {
            method: 'POST', token, body: { lastAckedSequence: delivered },
        });
        await updateSyncCursorState(accountId, deviceId, {
            lastPulledSequence: result.nextCursor,
            lastAckedSequence: delivered,
            lastSuccessfulSyncAt: Date.now(),
            lastErrorCode: null,
        });
    } else {
        await updateSyncCursorState(accountId, deviceId, {
            lastSuccessfulSyncAt: Date.now(),
            lastErrorCode: null,
        });
    }
    return { received: result.events.length, applied, conflicts, blocked };
}

export async function setCompanionRemoteSyncPolicy(enabled: boolean): Promise<void> {
    const connection = await getCompanionSyncConnection();
    if (!connection) return;
    const token = await secureStorageGet(TOKEN_KEY);
    if (!token) throw new Error('DEVICE_TOKEN_UNAVAILABLE_REPAIR_REQUIRED');
    await requestJson(connection.baseUrl, '/v1/sync/policy', {
        method: 'POST', token, body: { entityType: 'room_note', enabled },
    });
}

export async function syncCompanionOnce(): Promise<{
    pushed: number;
    received: number;
    applied: number;
    conflicts: number;
    blocked: number;
}> {
    const connection = await getCompanionSyncConnection();
    if (!connection) throw new Error('COMPANION_NOT_PAIRED');
    const token = await secureStorageGet(TOKEN_KEY);
    if (!token) throw new Error('DEVICE_TOKEN_UNAVAILABLE_REPAIR_REQUIRED');
    try {
        const preference = await getSyncPreference('room_note');
        if (!preference.enabled || preference.mode !== 'text') {
            throw new Error('LOCAL_SYNC_CONSENT_REQUIRED');
        }
        const pushed = await pushPending(connection.baseUrl, token);
        const pulled = await pullAndApply(connection.baseUrl, token, connection.accountId, connection.serverDeviceId);
        return { pushed, ...pulled };
    } catch (error) {
        await updateSyncCursorState(connection.accountId, connection.serverDeviceId, {
            lastErrorCode: error instanceof Error ? error.message.slice(0, 80) : 'SYNC_FAILED',
        }).catch(() => {});
        throw error;
    }
}
