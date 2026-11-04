import { beforeEach, describe, expect, it } from 'vitest';
import { DB } from '../db';
import { assertAssetPrivacy, TASK_TRANSITIONS, visualCompanionRepository } from './repository';
import type { VisualAssetRecord, VisualTask } from './types';

const now = 1_800_000_000_000;

beforeEach(async () => {
    await DB.deleteDB();
    localStorage.clear();
});

const task = (overrides: Partial<VisualTask> = {}): VisualTask => ({
    id: 'task_1',
    charId: 'char_1',
    kind: 'spontaneous_share',
    status: 'queued',
    privacyScope: 'standard',
    provider: 'openai',
    providerConfigId: 'provider_1',
    model: 'gpt-image',
    prompt: 'window light portrait',
    referenceAssetIds: [],
    deliveryId: 'delivery_1',
    attempt: 0,
    maxAttempts: 3,
    budget: { maxImages: 1 },
    resultAssetIds: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
});

describe('视觉人格本地仓库', () => {
    it('支持角色档案和记忆的按角色读写', async () => {
        await visualCompanionRepository.saveProfile({
            id: 'profile_1',
            charId: 'char_1',
            version: 1,
            status: 'active',
            identity: [{ key: 'eye_color', value: '深棕色', confirmed: true, source: 'user', updatedAt: now }],
            anchorPrompt: '保持人物身份一致',
            createdAt: now,
            updatedAt: now,
        });
        await visualCompanionRepository.saveMemory({
            id: 'memory_1',
            charId: 'char_1',
            status: 'confirmed',
            source: 'user',
            category: 'hair',
            content: '黑色短发',
            locked: true,
            privacyScope: 'standard',
            createdAt: now,
            updatedAt: now,
        });

        expect((await visualCompanionRepository.listProfiles('char_1')).map(x => x.id)).toEqual(['profile_1']);
        expect((await visualCompanionRepository.listMemories('char_1')).map(x => x.content)).toEqual(['黑色短发']);
    });

    it('拒绝跨越非法任务状态，允许有效推进', async () => {
        await visualCompanionRepository.saveTask(task());
        await expect(visualCompanionRepository.transitionTask('task_1', 'delivered')).rejects.toThrow('不允许的视觉任务状态转换');
        const planned = await visualCompanionRepository.transitionTask('task_1', 'planning', {
            prompt: 'new prompt',
        });
        expect(planned.status).toBe('planning');
        const generating = await visualCompanionRepository.transitionTask('task_1', 'generating', {
            deliveryId: 'changed_delivery',
            privacyScope: 'private',
            charId: 'changed_character',
        } as any);
        expect(generating.status).toBe('generating');
        expect(generating.deliveryId).toBe('delivery_1');
        expect(generating.privacyScope).toBe('standard');
        expect(generating.charId).toBe('char_1');
        expect(TASK_TRANSITIONS.delivered).toEqual([]);
    });

    it('更新写真分镜时不允许改变分镜 id', async () => {
        await visualCompanionRepository.saveProject({
            id: 'project_1',
            charId: 'char_1',
            title: '初夏写真',
            concept: '自然光',
            privacyScope: 'standard',
            status: 'draft',
            shots: [{ id: 'shot_1', order: 1, scene: '窗边', prompt: '柔和日光', status: 'planned', retryCount: 0 }],
            createdAt: now,
            updatedAt: now,
        });
        const updated = await visualCompanionRepository.updateProjectShot('project_1', 'shot_1', {
            id: 'attacker_id',
            status: 'ready',
            assetId: 'asset_1',
        });
        expect(updated.shots[0].id).toBe('shot_1');
        expect(updated.shots[0].status).toBe('ready');
    });

    it('标准资产只接受 blobref，私密资产必须独立存储并带密钥版本', async () => {
        const standard: VisualAssetRecord = {
            id: 'asset_1',
            charId: 'char_1',
            privacyScope: 'standard',
            status: 'ready',
            mimeType: 'image/png',
            byteSize: 10,
            storage: { kind: 'blobref', ref: 'blobref:b_asset_1' },
            createdAt: now,
        };
        const privateAsset: VisualAssetRecord = {
            id: 'asset_private',
            charId: 'char_1',
            privacyScope: 'private',
            status: 'ready',
            mimeType: 'image/png',
            byteSize: 10,
            storage: { kind: 'private_local', ref: 'private:asset_private' },
            encryptionKeyVersion: 1,
            createdAt: now,
        };
        await visualCompanionRepository.saveAsset(standard);
        await visualCompanionRepository.saveAsset(privateAsset);
        expect((await visualCompanionRepository.listAssets('char_1')).length).toBe(2);

        expect(() => assertAssetPrivacy({
            ...standard,
            storage: { kind: 'private_local', ref: 'private:asset_2' },
        } as any)).toThrow('标准视觉资产必须使用 blobref');
        expect(() => assertAssetPrivacy({
            ...privateAsset,
            storage: { kind: 'blobref', ref: 'blobref:b_private' },
        } as any)).toThrow('私密视觉资产必须使用独立私密存储');
        await expect(visualCompanionRepository.deleteAsset('asset_private')).rejects.toThrow('私密资产必须先通过私密保险库');
        await visualCompanionRepository.deleteAsset('asset_1');
        expect(await visualCompanionRepository.getAsset('asset_1')).toBeNull();
    });
});
