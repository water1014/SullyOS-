import { openDB } from './db';

export type SyncEntityType = 'room_note';
export type SyncOperation = 'create' | 'update' | 'delete';
export type SyncPolicyMode = 'local_only' | 'text';

export interface SyncPreference {
    entityType: SyncEntityType;
    mode: SyncPolicyMode;
    enabled: boolean;
    updatedAt: number;
}

export interface LocalSyncEvent<TPayload = Record<string, unknown>> {
    eventId: string;
    entityType: SyncEntityType;
    entityId: string;
    operation: SyncOperation;
    baseVersion: number | null;
    clientVersion: number;
    clientCreatedAt: number;
    payload: TPayload;
    state: 'pending' | 'in_flight' | 'blocked';
    createdAt: number;
    retryAt: number;
    attemptCount: number;
    lastErrorCode?: string;
}

export interface SyncQueueSummary {
    pending: number;
    inFlight: number;
    blocked: number;
}

const OUTBOX = 'sync_outbox';
const PREFERENCES = 'sync_preferences';

function createEventId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    });
}

/** Sync is opt-in per entity type. The default is always local_only. */
export async function getSyncPreference(entityType: SyncEntityType): Promise<SyncPreference> {
    const db = await openDB();
    const tx = db.transaction(PREFERENCES, 'readonly');
    const done = transactionDone(tx);
    const record = await requestResult(tx.objectStore(PREFERENCES).get(entityType)) as SyncPreference | undefined;
    await done;
    return record ?? { entityType, mode: 'local_only', enabled: false, updatedAt: 0 };
}

export async function setSyncPreference(
    entityType: SyncEntityType,
    enabled: boolean,
    mode: SyncPolicyMode = enabled ? 'text' : 'local_only'
): Promise<SyncPreference> {
    if (enabled && mode !== 'text') throw new Error('Unsupported sync mode for this entity');
    const preference: SyncPreference = {
        entityType,
        enabled: enabled && mode === 'text',
        mode: enabled ? mode : 'local_only',
        updatedAt: Date.now(),
    };
    const db = await openDB();
    const stores = enabled ? [PREFERENCES] : [PREFERENCES, OUTBOX, INBOX];
    const tx = db.transaction(stores, 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(PREFERENCES).put(preference);
    if (!enabled) {
        const outbox = tx.objectStore(OUTBOX);
        const queued = await requestResult(outbox.getAll()) as LocalSyncEvent[];
        queued.filter(event => event.entityType === entityType).forEach(event => outbox.delete(event.eventId));
        const inbox = tx.objectStore(INBOX);
        const incoming = await requestResult(inbox.getAll()) as LocalSyncInboxEvent[];
        incoming
            .filter(event => event.entityType === entityType && event.applyState !== 'applied')
            .forEach(event => inbox.delete(event.eventId));
    }
    await done;
    return preference;
}

/**
 * Room-note allowlist serializer. It intentionally excludes relatedMessageId,
 * local-only identifiers, media references, and any unknown extension fields.
 */
export function serializeRoomNoteForSync(note: {
    id: string;
    charId: string;
    timestamp: number;
    content: string;
    type: 'lyric' | 'doodle' | 'thought' | 'search' | 'gossip';
}): Record<string, unknown> {
    return {
        id: note.id,
        charId: note.charId,
        timestamp: note.timestamp,
        content: note.content,
        type: note.type,
    };
}

export async function enqueueRoomNoteSyncEvent(
    note: Parameters<typeof serializeRoomNoteForSync>[0],
    operation: SyncOperation,
    options: { baseVersion?: number | null; clientVersion?: number } = {}
): Promise<LocalSyncEvent | null> {
    const preference = await getSyncPreference('room_note');
    if (!preference.enabled || preference.mode !== 'text') return null;

    const payload = operation === 'delete' ? {} : serializeRoomNoteForSync(note);
    const event: LocalSyncEvent = {
        eventId: createEventId(),
        entityType: 'room_note',
        entityId: note.id,
        operation,
        baseVersion: options.baseVersion ?? null,
        clientVersion: Math.max(1, options.clientVersion ?? 1),
        clientCreatedAt: Date.now(),
        payload,
        state: 'pending',
        createdAt: Date.now(),
        retryAt: 0,
        attemptCount: 0,
    };

    const db = await openDB();
    const tx = db.transaction(OUTBOX, 'readwrite');
    tx.objectStore(OUTBOX).add(event);
    await transactionDone(tx);
    return event;
}

export async function listPendingSyncEvents(limit = 50): Promise<LocalSyncEvent[]> {
    const db = await openDB();
    const tx = db.transaction(OUTBOX, 'readonly');
    const done = transactionDone(tx);
    const index = tx.objectStore(OUTBOX).index('state');
    const events = await requestResult(index.getAll('pending')) as LocalSyncEvent[];
    await done;
    return events.sort((a, b) => a.createdAt - b.createdAt).slice(0, Math.max(1, limit));
}

export async function updateSyncEventState(
    eventId: string,
    state: LocalSyncEvent['state'],
    errorCode?: string
): Promise<void> {
    const db = await openDB();
    const tx = db.transaction(OUTBOX, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(OUTBOX);
    const current = await requestResult(store.get(eventId)) as LocalSyncEvent | undefined;
    if (!current) {
        await done;
        throw new Error('Sync event not found');
    }
    store.put({
        ...current,
        state,
        attemptCount: state === 'in_flight' ? current.attemptCount + 1 : current.attemptCount,
        retryAt: state === 'pending' ? Date.now() : current.retryAt,
        lastErrorCode: errorCode ? errorCode.slice(0, 80) : undefined,
    });
    await done;
}

export async function removeSyncEvent(eventId: string): Promise<void> {
    const db = await openDB();
    const tx = db.transaction(OUTBOX, 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(OUTBOX).delete(eventId);
    await done;
}

export async function getSyncQueueSummary(): Promise<SyncQueueSummary> {
    const db = await openDB();
    const tx = db.transaction(OUTBOX, 'readonly');
    const done = transactionDone(tx);
    const store = tx.objectStore(OUTBOX);
    const [pending, inFlight, blocked] = await Promise.all([
        requestResult(store.index('state').count('pending')),
        requestResult(store.index('state').count('in_flight')),
        requestResult(store.index('state').count('blocked')),
    ]);
    await done;
    return { pending, inFlight, blocked };
}


export interface LocalSyncInboxEvent {
    eventId: string;
    serverSequence: number;
    entityType: SyncEntityType;
    entityId: string;
    operation: SyncOperation;
    entityVersion: number;
    payload: Record<string, unknown>;
    receivedAt: number;
    appliedAt?: number;
    applyState: 'pending' | 'applied' | 'blocked';
}

export interface SyncCursorState {
    id: string;
    accountId: string;
    deviceId: string;
    lastPulledSequence: number;
    lastAckedSequence: number;
    lastSuccessfulSyncAt: number | null;
    lastErrorCode?: string;
    updatedAt: number;
}

export interface LocalSyncConflict {
    conflictId: string;
    entityType: SyncEntityType;
    entityId: string;
    localVersion: number;
    remoteVersion: number;
    localSnapshotRef?: string;
    remoteSnapshotRef?: string;
    localSnapshot?: Record<string, unknown> | null;
    remoteSnapshot?: Record<string, unknown> | null;
    detectedAt: number;
    resolutionState: 'unresolved' | 'keep_local' | 'keep_remote' | 'merged';
}

const INBOX = 'sync_inbox';
const SYNC_STATE = 'sync_state';
const CONFLICTS = 'sync_conflicts';

export async function getSyncPreferences(): Promise<SyncPreference[]> {
    const db = await openDB();
    const tx = db.transaction(PREFERENCES, 'readonly');
    const done = transactionDone(tx);
    const records = await requestResult(tx.objectStore(PREFERENCES).getAll()) as SyncPreference[];
    await done;
    return records;
}

export async function persistInboxEvents(events: Omit<LocalSyncInboxEvent, 'receivedAt' | 'applyState'>[]): Promise<number> {
    if (events.length === 0) return 0;
    if (events.some(event => !Number.isSafeInteger(event.serverSequence) || event.serverSequence < 1)) {
        throw new Error('INVALID_SERVER_SEQUENCE');
    }
    const db = await openDB();
    const tx = db.transaction(INBOX, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(INBOX);
    let inserted = 0;
    for (const event of events) {
        const existing = await requestResult(store.get(event.eventId)) as LocalSyncInboxEvent | undefined;
        if (!existing) {
            store.add({ ...event, receivedAt: Date.now(), applyState: 'pending' } satisfies LocalSyncInboxEvent);
            inserted += 1;
        }
    }
    await done;
    return inserted;
}

export async function listPendingInboxEvents(limit = 50): Promise<LocalSyncInboxEvent[]> {
    const db = await openDB();
    const tx = db.transaction(INBOX, 'readonly');
    const done = transactionDone(tx);
    const events = await requestResult(tx.objectStore(INBOX).index('applyState').getAll('pending')) as LocalSyncInboxEvent[];
    await done;
    return events.sort((a, b) => a.serverSequence - b.serverSequence).slice(0, Math.max(1, limit));
}

export async function markInboxEventApplied(eventId: string): Promise<void> {
    const db = await openDB();
    const tx = db.transaction(INBOX, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(INBOX);
    const current = await requestResult(store.get(eventId)) as LocalSyncInboxEvent | undefined;
    if (!current) throw new Error('INBOX_EVENT_NOT_FOUND');
    store.put({ ...current, applyState: 'applied', appliedAt: Date.now() });
    await done;
}

export async function getSyncCursorState(accountId: string, deviceId: string): Promise<SyncCursorState> {
    const id = `${accountId}:${deviceId}`;
    const db = await openDB();
    const tx = db.transaction(SYNC_STATE, 'readonly');
    const done = transactionDone(tx);
    const stored = await requestResult(tx.objectStore(SYNC_STATE).get(id)) as SyncCursorState | undefined;
    await done;
    return stored ?? { id, accountId, deviceId, lastPulledSequence: 0, lastAckedSequence: 0, lastSuccessfulSyncAt: null, updatedAt: 0 };
}

export async function updateSyncCursorState(
    accountId: string,
    deviceId: string,
    patch: Partial<Pick<SyncCursorState, 'lastPulledSequence' | 'lastAckedSequence' | 'lastSuccessfulSyncAt' | 'lastErrorCode'>>
): Promise<SyncCursorState> {
    const current = await getSyncCursorState(accountId, deviceId);
    const next: SyncCursorState = {
        ...current, ...patch,
        lastPulledSequence: Math.max(current.lastPulledSequence, patch.lastPulledSequence ?? 0),
        lastAckedSequence: Math.max(current.lastAckedSequence, patch.lastAckedSequence ?? 0),
        lastErrorCode: patch.lastErrorCode?.slice(0, 80),
        updatedAt: Date.now(),
    };
    const db = await openDB();
    const tx = db.transaction(SYNC_STATE, 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(SYNC_STATE).put(next);
    await done;
    return next;
}

export async function recordSyncConflict(
    conflict: Omit<LocalSyncConflict, 'detectedAt' | 'resolutionState'> & { detectedAt?: number }
): Promise<LocalSyncConflict> {
    const record: LocalSyncConflict = { ...conflict, detectedAt: conflict.detectedAt ?? Date.now(), resolutionState: 'unresolved' };
    const db = await openDB();
    const tx = db.transaction(CONFLICTS, 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(CONFLICTS).put(record);
    await done;
    return record;
}

export async function listUnresolvedSyncConflicts(): Promise<LocalSyncConflict[]> {
    const db = await openDB();
    const tx = db.transaction(CONFLICTS, 'readonly');
    const done = transactionDone(tx);
    const records = await requestResult(tx.objectStore(CONFLICTS).index('resolutionState').getAll('unresolved')) as LocalSyncConflict[];
    await done;
    return records.sort((a, b) => a.detectedAt - b.detectedAt);
}

export async function resolveSyncConflict(
    conflictId: string,
    resolutionState: Exclude<LocalSyncConflict['resolutionState'], 'unresolved'>
): Promise<void> {
    const db = await openDB();
    const tx = db.transaction(CONFLICTS, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(CONFLICTS);
    const current = await requestResult(store.get(conflictId)) as LocalSyncConflict | undefined;
    if (!current) throw new Error('SYNC_CONFLICT_NOT_FOUND');
    store.put({ ...current, resolutionState });
    await done;
}


export type InboxApplyResult =
    | { status: 'applied' }
    | { status: 'conflict'; conflictId: string }
    | { status: 'blocked'; reason: string };

const ROOM_NOTE_TYPES = new Set(['lyric', 'doodle', 'thought', 'search', 'gossip']);

function parseRemoteRoomNote(event: LocalSyncInboxEvent): Record<string, unknown> | null {
    if (event.entityType !== 'room_note' || event.operation === 'delete') return null;
    const payload = event.payload;
    if (
        payload.id !== event.entityId
        || typeof payload.charId !== 'string' || !payload.charId
        || typeof payload.timestamp !== 'number' || !Number.isFinite(payload.timestamp)
        || typeof payload.content !== 'string'
        || typeof payload.type !== 'string' || !ROOM_NOTE_TYPES.has(payload.type)
    ) return null;
    return {
        id: payload.id,
        charId: payload.charId,
        timestamp: payload.timestamp,
        content: payload.content,
        type: payload.type,
    };
}

/** Apply remote note + inbox state atomically; never silently overwrite a local edit. */
export async function applyPendingRoomNoteInboxEvent(eventId: string): Promise<InboxApplyResult> {
    const db = await openDB();
    const tx = db.transaction([INBOX, 'room_notes', CONFLICTS, PREFERENCES], 'readwrite');
    const done = transactionDone(tx);
    const inbox = tx.objectStore(INBOX);
    const notes = tx.objectStore('room_notes');
    const conflicts = tx.objectStore(CONFLICTS);
    const preferences = tx.objectStore(PREFERENCES);
    const event = await requestResult(inbox.get(eventId)) as LocalSyncInboxEvent | undefined;
    if (!event) {
        await done;
        throw new Error('INBOX_EVENT_NOT_FOUND');
    }
    if (event.applyState === 'applied') {
        await done;
        return { status: 'applied' };
    }
    if (event.applyState === 'blocked') {
        await done;
        return { status: 'blocked', reason: 'EVENT_ALREADY_BLOCKED' };
    }
    if (event.entityType !== 'room_note') {
        inbox.put({ ...event, applyState: 'blocked' });
        await done;
        return { status: 'blocked', reason: 'UNSUPPORTED_ENTITY' };
    }
    const preference = await requestResult(preferences.get('room_note')) as SyncPreference | undefined;
    if (!preference?.enabled || preference.mode !== 'text') {
        inbox.delete(eventId);
        await done;
        return { status: 'blocked', reason: 'SYNC_DISABLED' };
    }
    if (!['create', 'update', 'delete'].includes(event.operation)
        || !Number.isSafeInteger(event.entityVersion) || event.entityVersion < 1) {
        inbox.put({ ...event, applyState: 'blocked' });
        await done;
        return { status: 'blocked', reason: 'INVALID_EVENT_METADATA' };
    }

    const local = await requestResult(notes.get(event.entityId)) as Record<string, unknown> | undefined;
    const remote = parseRemoteRoomNote(event);
    if (event.operation !== 'delete' && !remote) {
        inbox.put({ ...event, applyState: 'blocked' });
        await done;
        return { status: 'blocked', reason: 'INVALID_ROOM_NOTE_PAYLOAD' };
    }
    const sameContent = Boolean(local && remote
        && local.id === remote.id && local.charId === remote.charId
        && local.timestamp === remote.timestamp && local.content === remote.content
        && local.type === remote.type);

    if (!local || sameContent) {
        if (event.operation === 'delete') notes.delete(event.entityId);
        else if (remote) notes.put(remote);
        inbox.put({ ...event, applyState: 'applied', appliedAt: Date.now() });
        await done;
        return { status: 'applied' };
    }

    conflicts.put({
        conflictId: event.eventId,
        entityType: 'room_note',
        entityId: event.entityId,
        localVersion: 0,
        remoteVersion: event.entityVersion,
        localSnapshot: {
            id: local.id, charId: local.charId, timestamp: local.timestamp,
            content: local.content, type: local.type,
        },
        remoteSnapshot: remote,
        detectedAt: Date.now(),
        resolutionState: 'unresolved',
    } satisfies LocalSyncConflict);
    inbox.put({ ...event, applyState: 'blocked' });
    await done;
    return { status: 'conflict', conflictId: event.eventId };
}

/** Resolve a conflict and mark its inbox event applied in the same transaction. */
export async function resolveRoomNoteSyncConflict(
    conflictId: string,
    resolution: 'keep_local' | 'keep_remote',
): Promise<void> {
    const db = await openDB();
    const tx = db.transaction([CONFLICTS, INBOX, 'room_notes'], 'readwrite');
    const done = transactionDone(tx);
    const conflicts = tx.objectStore(CONFLICTS);
    const inbox = tx.objectStore(INBOX);
    const notes = tx.objectStore('room_notes');
    const conflict = await requestResult(conflicts.get(conflictId)) as LocalSyncConflict | undefined;
    const event = await requestResult(inbox.get(conflictId)) as LocalSyncInboxEvent | undefined;
    if (!conflict || !event) {
        await done;
        throw new Error('SYNC_CONFLICT_NOT_FOUND');
    }
    if (resolution === 'keep_remote') {
        if (conflict.remoteSnapshot) notes.put(conflict.remoteSnapshot);
        else notes.delete(conflict.entityId);
    }
    conflicts.put({ ...conflict, resolutionState: resolution });
    inbox.put({ ...event, applyState: 'applied', appliedAt: Date.now() });
    await done;
}
