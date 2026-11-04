import { beforeEach, describe, expect, it } from 'vitest';
import { DB, openDB } from './db';
import {
    enqueueRoomNoteSyncEvent,
    persistInboxEvents,
    listPendingInboxEvents,
    markInboxEventApplied,
    updateSyncCursorState,
    recordSyncConflict,
    listUnresolvedSyncConflicts,
    resolveSyncConflict,
    getSyncPreference,
    getSyncQueueSummary,
    listPendingSyncEvents,
    removeSyncEvent,
    serializeRoomNoteForSync,
    setSyncPreference,
    updateSyncEventState,
} from './localSyncStore';

const note = {
    id: 'note-1',
    charId: 'char-1',
    timestamp: 1700000000000,
    content: '今晚的月亮很好看',
    type: 'thought' as const,
};

describe('local-first sync outbox', () => {
    beforeEach(async () => {
        await DB.deleteDB();
    });

    it('upgrades an existing v75 database additively and preserves room notes', async () => {
        const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('AetherOS_Data', 75);
            request.onupgradeneeded = () => {
                const notes = request.result.createObjectStore('room_notes', { keyPath: 'id' });
                notes.createIndex('charId', 'charId', { unique: false });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const seed = legacy.transaction('room_notes', 'readwrite');
        seed.objectStore('room_notes').put({
            id: 'legacy-note',
            charId: 'char-legacy',
            timestamp: 1,
            content: '保留这条旧便签',
            type: 'thought',
        });
        await new Promise<void>((resolve, reject) => {
            seed.oncomplete = () => resolve();
            seed.onerror = () => reject(seed.error);
            seed.onabort = () => reject(seed.error);
        });
        legacy.close();

        const upgraded = await openDB();
        expect(upgraded.version).toBe(76);
        for (const store of ['room_notes', 'sync_outbox', 'sync_inbox', 'sync_state', 'sync_conflicts', 'sync_preferences']) {
            expect(upgraded.objectStoreNames.contains(store)).toBe(true);
        }
        const read = upgraded.transaction('room_notes', 'readonly');
        const preserved = await new Promise((resolve, reject) => {
            const request = read.objectStore('room_notes').get('legacy-note');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        expect(preserved).toMatchObject({ id: 'legacy-note', content: '保留这条旧便签' });
    });


    it('persists inbox events idempotently and orders them by server sequence', async () => {
        const incoming = [
            { eventId: 'remote-2', serverSequence: 2, entityType: 'room_note' as const, entityId: 'n2', operation: 'create' as const, entityVersion: 1, payload: { content: 'second' } },
            { eventId: 'remote-1', serverSequence: 1, entityType: 'room_note' as const, entityId: 'n1', operation: 'create' as const, entityVersion: 1, payload: { content: 'first' } },
        ];
        expect(await persistInboxEvents(incoming)).toBe(2);
        expect(await persistInboxEvents(incoming)).toBe(0);
        expect((await listPendingInboxEvents()).map(event => event.eventId)).toEqual(['remote-1', 'remote-2']);
        await markInboxEventApplied('remote-1');
        expect((await listPendingInboxEvents()).map(event => event.eventId)).toEqual(['remote-2']);
    });

    it('keeps cursors monotonic and records resolvable conflicts', async () => {
        const first = await updateSyncCursorState('account-1', 'device-1', { lastPulledSequence: 10, lastAckedSequence: 8 });
        const stale = await updateSyncCursorState('account-1', 'device-1', { lastPulledSequence: 4, lastAckedSequence: 3 });
        expect(first.lastPulledSequence).toBe(10);
        expect(stale.lastPulledSequence).toBe(10);
        expect(stale.lastAckedSequence).toBe(8);
        await recordSyncConflict({ conflictId: 'conflict-1', entityType: 'room_note', entityId: 'note-1', localVersion: 2, remoteVersion: 3 });
        expect(await listUnresolvedSyncConflicts()).toHaveLength(1);
        await resolveSyncConflict('conflict-1', 'keep_local');
        expect(await listUnresolvedSyncConflicts()).toHaveLength(0);
    });

    it('defaults to local-only and does not queue without explicit opt-in', async () => {
        expect(await getSyncPreference('room_note')).toMatchObject({
            enabled: false,
            mode: 'local_only',
        });
        expect(await enqueueRoomNoteSyncEvent(note, 'create')).toBeNull();
        expect(await getSyncQueueSummary()).toEqual({ pending: 0, inFlight: 0, blocked: 0 });
    });

    it('queues a text-only allowlisted room-note event after explicit opt-in', async () => {
        await setSyncPreference('room_note', true, 'text');
        const event = await enqueueRoomNoteSyncEvent({
            ...note,
            relatedMessageId: 99,
            privateBlobId: 'must-not-leak',
        } as typeof note, 'create');

        expect(event).not.toBeNull();
        expect(event?.payload).toEqual({
            id: note.id,
            charId: note.charId,
            timestamp: note.timestamp,
            content: note.content,
            type: note.type,
        });
        expect(JSON.stringify(event)).not.toContain('must-not-leak');
        expect(await listPendingSyncEvents()).toHaveLength(1);
        expect(await getSyncQueueSummary()).toEqual({ pending: 1, inFlight: 0, blocked: 0 });
    });

    it('keeps event identity stable while retrying and increments attempts', async () => {
        await setSyncPreference('room_note', true, 'text');
        const event = await enqueueRoomNoteSyncEvent(note, 'create');
        expect(event).not.toBeNull();

        await updateSyncEventState(event!.eventId, 'in_flight');
        await updateSyncEventState(event!.eventId, 'pending', 'NETWORK_UNAVAILABLE');

        const [pending] = await listPendingSyncEvents();
        expect(pending.eventId).toBe(event!.eventId);
        expect(pending.attemptCount).toBe(1);
        expect(pending.lastErrorCode).toBe('NETWORK_UNAVAILABLE');
    });

    it('purges queued note content when the user disables sync', async () => {
        await setSyncPreference('room_note', true, 'text');
        await enqueueRoomNoteSyncEvent(note, 'create');
        expect(await listPendingSyncEvents()).toHaveLength(1);

        await setSyncPreference('room_note', false);
        expect(await getSyncPreference('room_note')).toMatchObject({
            enabled: false,
            mode: 'local_only',
        });
        expect(await listPendingSyncEvents()).toHaveLength(0);
    });

    it('uses an empty payload for delete events', async () => {
        await setSyncPreference('room_note', true, 'text');
        const event = await enqueueRoomNoteSyncEvent(note, 'delete');
        expect(event?.payload).toEqual({});
        expect(event?.operation).toBe('delete');
    });

    it('removes an event after it has been acknowledged', async () => {
        await setSyncPreference('room_note', true, 'text');
        const event = await enqueueRoomNoteSyncEvent(note, 'create');
        await removeSyncEvent(event!.eventId);
        expect(await listPendingSyncEvents()).toHaveLength(0);
    });

    it('serializes only the explicit room-note allowlist', () => {
        const payload = serializeRoomNoteForSync({
            ...note,
            relatedMessageId: 42,
            secret: 'no',
        } as typeof note);
        expect(payload).not.toHaveProperty('relatedMessageId');
        expect(payload).not.toHaveProperty('secret');
    });
});
