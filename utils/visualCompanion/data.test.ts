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
    it('v75 增量创建视觉 Store，同时保留原聊天与生图室 Store', async () => {
        const db = await openDB();
        expect(db.version).toBe(75);

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
