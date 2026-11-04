import { beforeEach, describe, expect, it } from 'vitest';
import { DB, openDB } from './db';
import {
    enqueueRoomNoteSyncEvent,
    persistInboxEvents,
    applyPendingRoomNoteInboxEvent,
    resolveRoomNoteSyncConflict,
    listPendingInboxEvents,
    markInboxEventApplied,
    updateSyncCursorState,
    recordSyncConflict,
    listUnresolvedSyncConflicts,
    resolveSyncConflict,
    getSyncPreference,
    getSyncCursorState,
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
                const db = request.result;
                const notes = db.createObjectStore('room_notes', { keyPath: 'id' });
                notes.createIndex('charId', 'charId', { unique: false });
                db.createObjectStore('characters', { keyPath: 'id' });
                db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
                db.createObjectStore('blob_assets', { keyPath: 'id' });
                db.createObjectStore('private_visual_blobs', { keyPath: 'id' });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const seed = legacy.transaction(['room_notes', 'characters', 'messages', 'blob_assets', 'private_visual_blobs'], 'readwrite');
        seed.objectStore('room_notes').put({
            id: 'legacy-note',
            charId: 'char-legacy',
            timestamp: 1,
            content: '保留这条旧便签',
            type: 'thought',
        });
        seed.objectStore('characters').put({ id: 'char-legacy', name: '旧角色' });
        seed.objectStore('messages').put({ charId: 'char-legacy', role: 'assistant', content: '旧聊天记录' });
        seed.objectStore('blob_assets').put({ id: 'asset-legacy', blob: new Blob(['image-bytes']) });
        seed.objectStore('private_visual_blobs').put({ id: 'private-legacy', charId: 'char-legacy', blob: new Blob(['private-bytes']) });
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
        const preservedStores = upgraded.transaction(
            ['characters', 'messages', 'blob_assets', 'private_visual_blobs'], 'readonly'
        );
        const readOne = (store: string, key: IDBValidKey) => new Promise<any>((resolve, reject) => {
            const request = preservedStores.objectStore(store).get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const [character, message, imageAsset, privateAsset] = await Promise.all([
            readOne('characters', 'char-legacy'),
            readOne('messages', 1),
            readOne('blob_assets', 'asset-legacy'),
            readOne('private_visual_blobs', 'private-legacy'),
        ]);
        expect(character).toMatchObject({ id: 'char-legacy', name: '旧角色' });
        expect(message).toMatchObject({ id: 1, content: '旧聊天记录' });
        expect(await imageAsset.blob.text()).toBe('image-bytes');
        expect(await privateAsset.blob.text()).toBe('private-bytes');
    });


    it('clears stale sync queues and cursors after a text/full restore, while retaining the user opt-in', async () => {
        await setSyncPreference('room_note', true, 'text');
        await enqueueRoomNoteSyncEvent(note, 'create');
        await persistInboxEvents([{
            eventId: 'restore-stale-inbox', serverSequence: 12, entityType: 'room_note',
            entityId: 'remote-note', operation: 'create', entityVersion: 1,
            payload: { id: 'remote-note', charId: 'char-1', timestamp: 10, content: '旧待同步内容', type: 'thought' },
        }]);
        await updateSyncCursorState('account-restore', 'device-restore', {
            lastPulledSequence: 12, lastAckedSequence: 10,
        });
        await recordSyncConflict({
            conflictId: 'restore-stale-conflict', entityType: 'room_note',
            entityId: 'note-1', localVersion: 1, remoteVersion: 2,
        });

        await DB.importFullData({ characters: [], messages: [] } as any);

        expect(await listPendingSyncEvents()).toHaveLength(0);
        expect(await listPendingInboxEvents()).toHaveLength(0);
        expect(await listUnresolvedSyncConflicts()).toHaveLength(0);
        expect(await getSyncCursorState('account-restore', 'device-restore')).toMatchObject({
            lastPulledSequence: 0, lastAckedSequence: 0,
        });
        expect(await getSyncPreference('room_note')).toMatchObject({
            enabled: true, mode: 'text',
        });
    });

    it('leaves sync metadata untouched for media-only restores', async () => {
        await setSyncPreference('room_note', true, 'text');
        await enqueueRoomNoteSyncEvent(note, 'create');
        await DB.importFullData({ collaborationBackupMode: 'media_only', mediaAssets: [] } as any);
        expect(await listPendingSyncEvents()).toHaveLength(1);
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

    it('rejects inbox event identity or sequence collisions instead of silently accepting changed data', async () => {
        const original = {
            eventId: 'remote-stable', serverSequence: 4, entityType: 'room_note' as const,
            entityId: 'note-stable', operation: 'create' as const, entityVersion: 1,
            payload: { id: 'note-stable', charId: 'char-1', timestamp: 1, content: 'original', type: 'thought' },
        };
        await persistInboxEvents([original]);
        await expect(persistInboxEvents([{
            ...original, payload: { ...original.payload, content: 'tampered replay' },
        }])).rejects.toThrow('INBOX_EVENT_ID_COLLISION');
        await expect(persistInboxEvents([{
            ...original, eventId: 'different-event', entityId: 'different-note',
        }])).rejects.toThrow('INBOX_SEQUENCE_COLLISION');
        expect(await listPendingInboxEvents()).toHaveLength(1);
    });

    it('bounds inbound batches and payload size and rejects malformed metadata', async () => {
        const base = {
            eventId: 'remote-bounded', serverSequence: 1, entityType: 'room_note' as const,
            entityId: 'note-bounded', operation: 'create' as const, entityVersion: 1,
            payload: { content: 'ok' },
        };
        await expect(persistInboxEvents(Array.from({ length: 101 }, (_, index) => ({
            ...base, eventId: `batch-${index}`, serverSequence: index + 1,
        })))).rejects.toThrow('INBOX_BATCH_TOO_LARGE');
        await expect(persistInboxEvents([{ ...base, payload: { content: 'x'.repeat(65 * 1024) } }]))
            .rejects.toThrow('INBOX_PAYLOAD_TOO_LARGE');
        await expect(persistInboxEvents([{ ...base, operation: 'unknown' as any }]))
            .rejects.toThrow('INVALID_INBOX_METADATA');
        await expect(persistInboxEvents([{ ...base, operation: 'delete', payload: { content: 'must be empty' } }]))
            .rejects.toThrow('DELETE_EVENT_PAYLOAD_MUST_BE_EMPTY');
        expect(await listPendingInboxEvents()).toHaveLength(0);
    });



    it('does not apply inbound note data without opt-in and purges pending inbound data when disabled', async () => {
        const remote = {
            eventId: 'remote-opt-in', serverSequence: 9, entityType: 'room_note' as const,
            entityId: 'remote-opt-in-note', operation: 'create' as const, entityVersion: 1,
            payload: { id: 'remote-opt-in-note', charId: 'char-1', timestamp: 10, content: '不得自动落地', type: 'thought' },
        };
        await persistInboxEvents([remote]);
        expect(await applyPendingRoomNoteInboxEvent(remote.eventId)).toEqual({
            status: 'blocked', reason: 'SYNC_DISABLED',
        });
        expect(await listPendingInboxEvents()).toHaveLength(0);

        await setSyncPreference('room_note', true, 'text');
        await persistInboxEvents([{ ...remote, eventId: 'remote-opt-in-2', serverSequence: 10 }]);
        expect(await listPendingInboxEvents()).toHaveLength(1);
        await setSyncPreference('room_note', false, 'local_only');
        expect(await listPendingInboxEvents()).toHaveLength(0);
    });

    it('applies a remote note when no local note exists', async () => {
        await setSyncPreference('room_note', true, 'text');
        await persistInboxEvents([{
            eventId: 'remote-create', serverSequence: 1, entityType: 'room_note',
            entityId: 'remote-note', operation: 'create', entityVersion: 1,
            payload: { id: 'remote-note', charId: 'char-1', timestamp: 10, content: '来自另一台设备', type: 'thought' },
        }]);
        expect(await applyPendingRoomNoteInboxEvent('remote-create')).toEqual({ status: 'applied' });
        const db = await openDB();
        const read = db.transaction(['room_notes', 'sync_inbox'], 'readonly');
        const [saved, inbox] = await Promise.all([
            new Promise<any>((resolve, reject) => {
                const request = read.objectStore('room_notes').get('remote-note');
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            }),
            new Promise<any>((resolve, reject) => {
                const request = read.objectStore('sync_inbox').get('remote-create');
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            }),
        ]);
        expect(saved).toMatchObject({ id: 'remote-note', content: '来自另一台设备' });
        expect(inbox.applyState).toBe('applied');
    });

    it('does not overwrite local edits and applies remote choice only after conflict resolution', async () => {
        await setSyncPreference('room_note', true, 'text');
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('room_notes', 'readwrite');
            tx.objectStore('room_notes').put({ ...note, content: '本机修改过的版本' });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        await persistInboxEvents([{
            eventId: 'remote-conflict', serverSequence: 2, entityType: 'room_note',
            entityId: note.id, operation: 'update', entityVersion: 2,
            payload: { ...note, content: '另一台设备修改的版本' },
        }]);
        expect(await applyPendingRoomNoteInboxEvent('remote-conflict')).toEqual({
            status: 'conflict', conflictId: 'remote-conflict',
        });
        const before = await new Promise<any>((resolve, reject) => {
            const tx = db.transaction('room_notes', 'readonly');
            const request = tx.objectStore('room_notes').get(note.id);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        expect(before.content).toBe('本机修改过的版本');

        await resolveRoomNoteSyncConflict('remote-conflict', 'keep_remote');
        const after = await new Promise<any>((resolve, reject) => {
            const tx = db.transaction('room_notes', 'readonly');
            const request = tx.objectStore('room_notes').get(note.id);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        expect(after.content).toBe('另一台设备修改的版本');
        expect(await listPendingInboxEvents()).toHaveLength(0);
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

    it('merges concurrent cursor updates atomically without losing the highest sequence', async () => {
        await Promise.all(Array.from({ length: 24 }, (_, index) =>
            updateSyncCursorState('account-concurrent', 'device-concurrent', {
                lastPulledSequence: index + 1,
                lastAckedSequence: index,
            })
        ));
        expect(await getSyncCursorState('account-concurrent', 'device-concurrent')).toMatchObject({
            lastPulledSequence: 24,
            lastAckedSequence: 23,
        });
    });

    it('rejects invalid cursor values and missing sync identity', async () => {
        await expect(updateSyncCursorState('', 'device-1', { lastPulledSequence: 1 }))
            .rejects.toThrow('SYNC_IDENTITY_REQUIRED');
        await expect(updateSyncCursorState('account-1', 'device-1', { lastPulledSequence: -1 }))
            .rejects.toThrow('INVALID_SYNC_CURSOR');
        await expect(updateSyncCursorState('account-1', 'device-1', { lastAckedSequence: 1.5 }))
            .rejects.toThrow('INVALID_SYNC_CURSOR');
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

    it('purges queued note content and conflict snapshots when the user disables sync', async () => {
        await setSyncPreference('room_note', true, 'text');
        await enqueueRoomNoteSyncEvent(note, 'create');
        await persistInboxEvents([
            {
                eventId: 'opt-out-conflict-event', serverSequence: 21, entityType: 'room_note',
                entityId: note.id, operation: 'update', entityVersion: 2,
                payload: { ...note, content: '另一台设备的副本' },
            },
            {
                eventId: 'opt-out-applied-event', serverSequence: 22, entityType: 'room_note',
                entityId: note.id, operation: 'update', entityVersion: 3,
                payload: { ...note, content: '已经应用过的远端副本' },
            },
        ]);
        await markInboxEventApplied('opt-out-applied-event');
        await recordSyncConflict({
            conflictId: 'opt-out-conflict', entityType: 'room_note', entityId: note.id,
            localVersion: 1, remoteVersion: 2,
            localSnapshot: { ...note },
            remoteSnapshot: { ...note, content: '另一台设备的副本' },
        });
        expect(await listPendingSyncEvents()).toHaveLength(1);
        expect(await listUnresolvedSyncConflicts()).toHaveLength(1);

        await setSyncPreference('room_note', false);
        expect(await getSyncPreference('room_note')).toMatchObject({
            enabled: false,
            mode: 'local_only',
        });
        expect(await listPendingSyncEvents()).toHaveLength(0);
        expect(await listPendingInboxEvents()).toHaveLength(0);
        expect(await listUnresolvedSyncConflicts()).toHaveLength(0);
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
