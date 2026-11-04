/**
 * 宋祁视觉人格系统 · 本地数据仓库
 *
 * 仅负责 IndexedDB 元数据读写。图片二进制由独立资产适配层管理；
 * 私密二进制不得通过本模块或普通 blob_assets 写入。
 */
import { openDB } from '../db';
import type {
    CharacterVisualProfile,
    PhotoProjectShot,
    VisualAssetRecord,
    VisualMemoryRecord,
    VisualPhotoProject,
    VisualTask,
    VisualTaskStatus,
} from './types';

type VisualStoreName =
    | 'visual_profiles'
    | 'visual_memories'
    | 'visual_projects'
    | 'visual_task_mirror'
    | 'visual_assets';

const STORE = {
    profiles: 'visual_profiles',
    memories: 'visual_memories',
    projects: 'visual_projects',
    tasks: 'visual_task_mirror',
    assets: 'visual_assets',
} as const satisfies Record<string, VisualStoreName>;

const TASK_TRANSITIONS: Record<VisualTaskStatus, readonly VisualTaskStatus[]> = {
    queued: ['planning', 'cancelled', 'failed'],
    planning: ['awaiting_approval', 'generating', 'cancelled', 'failed'],
    awaiting_approval: ['queued', 'cancelled', 'failed'],
    generating: ['persisting', 'retry_wait', 'cancelled', 'failed'],
    persisting: ['delivery_pending', 'retry_wait', 'failed'],
    delivery_pending: ['delivered', 'retry_wait', 'failed'],
    delivered: [],
    retry_wait: ['queued', 'generating', 'persisting', 'delivery_pending', 'cancelled', 'failed'],
    cancelled: [],
    failed: ['queued'],
};

function assertRecordId(id: string, label: string): void {
    if (!id || !id.trim()) throw new Error(label + ' id 不能为空');
}

function assertAssetPrivacy(record: VisualAssetRecord): void {
    if (record.privacyScope === 'standard') {
        if (record.storage.kind !== 'blobref' || !record.storage.ref.startsWith('blobref:')) {
            throw new Error('标准视觉资产必须使用 blobref: 存储引用');
        }
        if (record.encryptionKeyVersion !== undefined) {
            throw new Error('标准视觉资产不能携带私密密钥版本');
        }
        return;
    }
    if (record.storage.kind === 'blobref' || !record.encryptionKeyVersion || record.encryptionKeyVersion < 1) {
        throw new Error('私密视觉资产必须使用独立私密存储并指定密钥版本');
    }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB 请求失败'));
    });
}

async function readOne<T>(storeName: VisualStoreName, id: string): Promise<T | null> {
    assertRecordId(id, storeName);
    const db = await openDB();
    const tx = db.transaction(storeName, 'readonly');
    const result = await requestResult<T | undefined>(tx.objectStore(storeName).get(id));
    return result ?? null;
}

async function readByCharacter<T>(storeName: VisualStoreName, charId: string): Promise<T[]> {
    assertRecordId(charId, 'charId');
    const db = await openDB();
    const tx = db.transaction(storeName, 'readonly');
    return (await requestResult<T[]>(tx.objectStore(storeName).index('charId').getAll(IDBKeyRange.only(charId)))) || [];
}

async function writeOne<T extends { id: string }>(storeName: VisualStoreName, record: T): Promise<void> {
    assertRecordId(record.id, storeName);
    const db = await openDB();
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(record);
    await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('IndexedDB 写入失败'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB 写入已中止'));
    });
}

async function removeOne(storeName: VisualStoreName, id: string): Promise<void> {
    assertRecordId(id, storeName);
    const db = await openDB();
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(id);
    await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('IndexedDB 删除失败'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB 删除已中止'));
    });
}

async function updateOne<T extends { id: string }>(
    storeName: VisualStoreName,
    id: string,
    updater: (current: T) => T
): Promise<T> {
    assertRecordId(id, storeName);
    const db = await openDB();
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const current = await requestResult<T | undefined>(store.get(id));
    if (!current) {
        tx.abort();
        throw new Error('记录不存在：' + id);
    }
    const next = updater(current);
    if (next.id !== current.id) {
        tx.abort();
        throw new Error('更新不能改变记录 id');
    }
    store.put(next);
    await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('IndexedDB 更新失败'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB 更新已中止'));
    });
    return next;
}

export const visualCompanionRepository = {
    getProfile: (id: string) => readOne<CharacterVisualProfile>(STORE.profiles, id),
    listProfiles: (charId: string) => readByCharacter<CharacterVisualProfile>(STORE.profiles, charId),
    saveProfile: (record: CharacterVisualProfile) => writeOne(STORE.profiles, record),
    deleteProfile: (id: string) => removeOne(STORE.profiles, id),

    getMemory: (id: string) => readOne<VisualMemoryRecord>(STORE.memories, id),
    listMemories: (charId: string) => readByCharacter<VisualMemoryRecord>(STORE.memories, charId),
    saveMemory: (record: VisualMemoryRecord) => writeOne(STORE.memories, record),
    deleteMemory: (id: string) => removeOne(STORE.memories, id),

    getProject: (id: string) => readOne<VisualPhotoProject>(STORE.projects, id),
    listProjects: (charId: string) => readByCharacter<VisualPhotoProject>(STORE.projects, charId),
    saveProject: (record: VisualPhotoProject) => writeOne(STORE.projects, record),
    deleteProject: (id: string) => removeOne(STORE.projects, id),
    updateProjectShot: (projectId: string, shotId: string, patch: Partial<PhotoProjectShot>) =>
        updateOne<VisualPhotoProject>(STORE.projects, projectId, project => {
            const found = project.shots.some(shot => shot.id === shotId);
            if (!found) throw new Error('分镜不存在：' + shotId);
            return {
                ...project,
                updatedAt: Date.now(),
                shots: project.shots.map(shot => shot.id === shotId ? { ...shot, ...patch, id: shot.id } : shot),
            };
        }),

    getTask: (id: string) => readOne<VisualTask>(STORE.tasks, id),
    listTasks: (charId: string) => readByCharacter<VisualTask>(STORE.tasks, charId),
    saveTask: (record: VisualTask) => writeOne(STORE.tasks, record),
    transitionTask: (
        id: string,
        nextStatus: VisualTaskStatus,
        patch: Partial<Omit<VisualTask, 'id' | 'charId' | 'deliveryId' | 'privacyScope' | 'status' | 'createdAt'>> = {}
    ) =>
        updateOne<VisualTask>(STORE.tasks, id, current => {
            if (!TASK_TRANSITIONS[current.status].includes(nextStatus)) {
                throw new Error('不允许的视觉任务状态转换：' + current.status + ' -> ' + nextStatus);
            }
            return { ...current, ...patch, id: current.id, charId: current.charId, deliveryId: current.deliveryId, privacyScope: current.privacyScope, createdAt: current.createdAt, status: nextStatus, updatedAt: Date.now() };
        }),

    getAsset: (id: string) => readOne<VisualAssetRecord>(STORE.assets, id),
    listAssets: (charId: string) => readByCharacter<VisualAssetRecord>(STORE.assets, charId),
    saveAsset: (record: VisualAssetRecord) => {
        assertAssetPrivacy(record);
        return writeOne(STORE.assets, record);
    },
    deleteAsset: async (id: string) => {
        assertRecordId(id, STORE.assets);
        const db = await openDB();
        const tx = db.transaction(STORE.assets, 'readwrite');
        const store = tx.objectStore(STORE.assets);
        const request = store.get(id);
        const privateDeleteError = '私密资产必须先通过私密保险库完成加密销毁，不能直接删除元数据';
        const result = await new Promise<void>((resolve, reject) => {
            request.onsuccess = () => {
                const current = request.result as VisualAssetRecord | undefined;
                if (current?.privacyScope === 'private') {
                    try { tx.abort(); } catch { /* transaction may already be aborting */ }
                    reject(new Error(privateDeleteError));
                    return;
                }
                if (current) store.delete(id);
            };
            request.onerror = () => reject(request.error || new Error('读取视觉资产失败'));
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('删除视觉资产失败'));
            tx.onabort = () => reject(tx.error?.message === privateDeleteError ? tx.error : new Error('删除视觉资产已中止'));
        });
        return result;
    },
};

export { TASK_TRANSITIONS, assertAssetPrivacy };
