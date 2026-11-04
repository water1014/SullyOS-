import { beforeEach, describe, expect, it } from 'vitest';
import { DB } from '../db';
import { assertAssetPrivacy, TASK_TRANSITIONS, visualCompanionRepository } from './repository';
import { deliverVisualTaskToChat } from './delivery';
import type { VisualAssetRecord, VisualTask } from './types';
import { claimNextVisualTask, createAutonomousVisualTask, createVisualTask, markVisualAssetsPersisted, markVisualTaskDelivered, recordGeneratedVisualAssets, resumeVisualTaskRetry, scheduleVisualTaskRetry, startVisualGeneration } from './orchestrator';

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

    it('自主分享策略未放行时不会创建任务，特殊情境放行后才入队', async () => {
        const settings = {
            enabled: true,
            frequency: 'natural' as const,
            allowSpontaneousShare: true,
            allowPrivateCreation: false,
            requireApprovalForNewIdentity: true,
            dailyImageLimit: 2,
            updatedAt: now,
        };
        const input = {
            charId: 'char_policy',
            kind: 'spontaneous_share' as const,
            privacyScope: 'standard' as const,
            provider: 'openai' as const,
            providerConfigId: 'provider_ref_only',
            model: 'gpt-image',
            prompt: '一张自然日常照片',
            referenceAssetIds: [],
            maxAttempts: 3,
            budget: { maxImages: 1 },
        };
        const denied = await createAutonomousVisualTask(settings, {
            kind: 'ordinary_conversation',
            now,
            localTime: '12:00',
            imagesGeneratedToday: 0,
            sample: 0.9,
        }, input);
        expect(denied.decision).toEqual({ allowed: false, reason: 'not_selected' });
        expect(await visualCompanionRepository.listTasks('char_policy')).toHaveLength(0);

        const allowed = await createAutonomousVisualTask(settings, {
            kind: 'milestone',
            now,
            localTime: '12:00',
            imagesGeneratedToday: 0,
            sample: 0.5,
        }, input);
        expect(allowed.decision).toEqual({ allowed: true, reason: 'special_moment' });
        expect(allowed.task?.status).toBe('queued');
        expect(await visualCompanionRepository.listTasks('char_policy')).toHaveLength(1);
    });

    it('任务编排支持创建、认领、生成和进入投递阶段', async () => {
        const created = await createVisualTask({
            charId: 'char_1',
            kind: 'spontaneous_share',
            privacyScope: 'standard',
            provider: 'openai',
            providerConfigId: 'provider_ref_only',
            model: 'gpt-image',
            prompt: '窗边自然光',
            referenceAssetIds: [],
            maxAttempts: 3,
            budget: { maxImages: 1 },
        });
        expect(created.status).toBe('queued');
        expect(await createVisualTask({
            charId: 'char_1',
            kind: 'spontaneous_share',
            privacyScope: 'standard',
            provider: 'openai',
            providerConfigId: 'provider_ref_only',
            model: 'gpt-image',
            prompt: '重复请求',
            referenceAssetIds: [],
            maxAttempts: 3,
            budget: { maxImages: 1 },
            deliveryId: created.deliveryId,
        })).toEqual(created);

        const claimed = await claimNextVisualTask('char_1');
        expect(claimed?.id).toBe(created.id);
        expect(claimed?.status).toBe('planning');
        await startVisualGeneration(created.id);
        const generated = await recordGeneratedVisualAssets(created.id, ['asset_result_1']);
        expect(generated.status).toBe('persisting');
        expect(generated.resultAssetIds).toEqual(['asset_result_1']);
        const pending = await markVisualAssetsPersisted(created.id);
        expect(pending.status).toBe('delivery_pending');
    });

    it('将已保存的标准图片以幂等方式投递回角色聊天', async () => {
        const created = await createVisualTask({
            charId: 'char_1',
            kind: 'spontaneous_share',
            privacyScope: 'standard',
            provider: 'openai',
            providerConfigId: 'provider_ref_only',
            model: 'gpt-image',
            prompt: '只保留在任务侧的提示词',
            referenceAssetIds: [],
            maxAttempts: 3,
            budget: { maxImages: 1 },
        });
        await claimNextVisualTask('char_1');
        await startVisualGeneration(created.id);
        await recordGeneratedVisualAssets(created.id, ['asset_chat_1']);
        await markVisualAssetsPersisted(created.id);

        const first = await deliverVisualTaskToChat(created.id, 'blobref:b_visual_chat_1');
        const second = await deliverVisualTaskToChat(created.id, 'blobref:b_visual_chat_1');
        expect(first.messageId).toBe(second.messageId);
        expect(second.task.status).toBe('delivered');
        expect(second.task.deliveredMessageId).toBe(first.messageId);

        const messages = await DB.getMessagesByCharId('char_1', true);
        const delivered = messages.filter(message => message.metadata?.deliveryId === created.deliveryId);
        expect(delivered).toHaveLength(1);
        expect(delivered[0].role).toBe('assistant');
        expect(delivered[0].type).toBe('image');
        expect(delivered[0].content).toBe('blobref:b_visual_chat_1');
    });

    it('投递失败恢复时只回到 delivery_pending，不重新生成', async () => {
        const created = await createVisualTask({
            charId: 'char_1',
            kind: 'chat_requested',
            privacyScope: 'standard',
            provider: 'openai',
            providerConfigId: 'provider_ref_only',
            model: 'gpt-image',
            prompt: '已生成图片',
            referenceAssetIds: [],
            maxAttempts: 3,
            budget: { maxImages: 1 },
        });
        await claimNextVisualTask('char_1');
        await startVisualGeneration(created.id);
        await recordGeneratedVisualAssets(created.id, ['asset_already_generated']);
        await markVisualAssetsPersisted(created.id);
        const retryAt = Date.now() + 60_000;
        const waiting = await scheduleVisualTaskRetry(created.id, {
            code: 'CHAT_DELIVERY_FAILED',
            message: '聊天消息投递暂时失败',
        }, retryAt);
        expect(waiting.status).toBe('retry_wait');
        expect(waiting.retryStage).toBe('delivery_pending');
        expect(waiting.resultAssetIds).toEqual(['asset_already_generated']);
        await expect(resumeVisualTaskRetry(created.id)).rejects.toThrow('重试时间尚未到达');
        const resumed = await resumeVisualTaskRetry(created.id, retryAt);
        expect(resumed.status).toBe('delivery_pending');
        expect(resumed.resultAssetIds).toEqual(['asset_already_generated']);
        const delivered = await markVisualTaskDelivered(created.id);
        expect(delivered.status).toBe('delivered');
        expect(delivered.deliveryId).toBe(created.deliveryId);
    });
});
