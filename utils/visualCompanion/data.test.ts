import { beforeEach, describe, expect, it } from 'vitest';
import { DB, openDB } from '../db';

async function seedStore(name: string, rows: any[]) {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(name, 'readwrite');
        const store = tx.objectStore(name);
        rows.forEach(row => store.put(row));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('seed aborted'));
    });
}

async function readStore(name: string): Promise<any[]> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(name, 'readonly');
        const req = tx.objectStore(name).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

beforeEach(async () => {
    await DB.deleteDB();
    localStorage.clear();
});

describe('宋祁视觉人格系统 · P1 数据层', () => {
    it('从 v74 升级到 v76 时保留旧聊天、画廊和 Blob 数据', async () => {
        const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('AetherOS_Data', 74);
            request.onupgradeneeded = () => {
                const db = request.result;
                db.createObjectStore('messages', { keyPath: 'id' });
                db.createObjectStore('blob_assets', { keyPath: 'id' });
                db.createObjectStore('gallery', { keyPath: 'id' });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        await new Promise<void>((resolve, reject) => {
            const tx = legacy.transaction(['messages', 'blob_assets', 'gallery'], 'readwrite');
            tx.objectStore('messages').put({ id: 41, charId: 'c1', content: '旧聊天仍在' });
            tx.objectStore('blob_assets').put({ id: 'studio_legacy', blob: new Blob(['old image']) });
            tx.objectStore('gallery').put({ id: 'gallery_legacy', imageId: 'studio_legacy' });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        legacy.close();

        const upgraded = await openDB();
        expect(upgraded.version).toBe(76);
        expect(Array.from(upgraded.objectStoreNames)).toContain('visual_profiles');

        const read = (storeName: string) => new Promise<any[]>((resolve, reject) => {
            const tx = upgraded.transaction(storeName, 'readonly');
            const request = tx.objectStore(storeName).getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        expect((await read('messages'))[0].content).toBe('旧聊天仍在');
        expect((await read('blob_assets'))[0].id).toBe('studio_legacy');
        expect((await read('gallery'))[0].id).toBe('gallery_legacy');
    });

    it('v76 数据库保留视觉 Store 与同步 Store，同时保留原聊天与生图室 Store', async () => {
        const db = await openDB();
        expect(db.version).toBe(76);

        for (const name of [
            'visual_profiles',
            'visual_memories',
            'visual_projects',
            'visual_task_mirror',
            'visual_assets',
            'private_visual_blobs',
            'messages',
            'blob_assets',
            'gallery',
        ]) {
            expect(Array.from(db.objectStoreNames)).toContain(name);
        }
    });

    it('标准完整备份过滤私密记录和私密资产引用', async () => {
        await seedStore('visual_profiles', [
            { id: 'profile_private_base', charId: 'c1', version: 1, baseAssetId: 'asset_private' },
        ]);
        await seedStore('visual_memories', [
            { id: 'memory_standard', charId: 'c1', privacyScope: 'standard', content: '蓝色眼睛' },
            { id: 'memory_private', charId: 'c1', privacyScope: 'private', content: '私密记忆' },
        ]);
        await seedStore('visual_projects', [
            { id: 'project_standard', charId: 'c1', privacyScope: 'standard', title: '日常写真' },
            { id: 'project_private', charId: 'c1', privacyScope: 'private', title: '私密企划' },
        ]);
        await seedStore('visual_task_mirror', [
            { id: 'task_standard', charId: 'c1', privacyScope: 'standard', status: 'delivered' },
            { id: 'task_private', charId: 'c1', privacyScope: 'private', status: 'delivered' },
        ]);
        await seedStore('visual_assets', [
            { id: 'asset_standard', charId: 'c1', privacyScope: 'standard', storage: { kind: 'blobref', ref: 'blobref:b_standard' } },
            { id: 'asset_private', charId: 'c1', privacyScope: 'private', storage: { kind: 'private_local', ref: 'private:asset_private' }, encryptionKeyVersion: 1 },
        ]);
        await seedStore('private_visual_blobs', [
            { id: 'private_blob_1', charId: 'c1', createdAt: 1, ciphertext: new Uint8Array([1, 2, 3]) },
        ]);

        const backup = await DB.exportFullData();

        expect(backup.visualMemories?.map((x: any) => x.id)).toEqual(['memory_standard']);
        expect(backup.visualProjects?.map((x: any) => x.id)).toEqual(['project_standard']);
        expect(backup.visualTaskMirror?.map((x: any) => x.id)).toEqual(['task_standard']);
        expect(backup.visualAssets?.map((x: any) => x.id)).toEqual(['asset_standard']);
        expect(backup.visualProfiles?.[0]?.baseAssetId).toBeUndefined();
        expect((backup as any).privateVisualBlobs).toBeUndefined();
    });

    it('导入标准备份时保留本机私密记录并拒绝包内私密记录', async () => {
        await seedStore('visual_memories', [
            { id: 'local_private', charId: 'c1', privacyScope: 'private', content: '本机私密内容' },
            { id: 'old_standard', charId: 'c1', privacyScope: 'standard', content: '旧标准记录' },
        ]);

        await DB.importFullData({
            timestamp: Date.now(),
            version: 1,
            visualMemories: [
                { id: 'backup_standard', charId: 'c1', privacyScope: 'standard', content: '备份标准记录' },
                { id: 'backup_private', charId: 'c1', privacyScope: 'private', content: '不应导入' },
            ],
        } as any);

        const rows = await readStore('visual_memories');
        expect(rows.map(x => x.id).sort()).toEqual(['backup_standard', 'local_private']);
        expect(rows.find(x => x.id === 'local_private')?.content).toBe('本机私密内容');
    });
});
