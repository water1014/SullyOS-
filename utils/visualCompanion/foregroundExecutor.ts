/**
 * Foreground executor for visual companion tasks.
 *
 * Uses the existing Image Studio provider settings in this browser session.
 * Credentials/custom headers are read locally and are never copied into VisualTask records.
 * This is deliberately not a background/cloud executor: it runs only while the page is alive.
 */
import { editGptImage, generateGptImage, generateNaiImage, type GptImageConfig, type NaiImageConfig } from '../imageGeneration';
import { getBlobForRef, putImageBlob } from '../blobRef';
import { mergeCharacterVisualContextPrompt } from './identityPrompt';
import { resolveVisualReferenceAssetId } from './referenceAsset';
import {
    markVisualAssetsPersisted,
    recordGeneratedVisualAssets,
    resumeVisualTaskRetry,
    startVisualGeneration,
} from './orchestrator';
import { visualCompanionRepository } from './repository';
import { deliverVisualTaskToChat } from './delivery';
import type { VisualTask } from './types';

const IMAGE_CONFIG_KEY = 'sully-image-studio:config:v1';

function readImageStudioConfig(): any {
    try {
        return JSON.parse(localStorage.getItem(IMAGE_CONFIG_KEY) || '{}');
    } catch {
        throw new Error('读取生图室配置失败，请重新打开生图室检查设置');
    }
}

function getProviderConfig(task: VisualTask): GptImageConfig | NaiImageConfig {
    const saved = readImageStudioConfig();
    if (task.provider === 'openai' || task.provider === 'openai_compatible') {
        const config = saved.gpt;
        if (!config?.apiKey?.trim()) throw new Error('GPT 生图尚未配置 API Key');
        return { ...config, model: task.model || config.model } as GptImageConfig;
    }
    if (task.provider === 'novelai_official') {
        const config = saved.naiOfficial || (saved.nai?.provider !== 'thirdparty' ? saved.nai : null);
        if (!config?.apiKey?.trim()) throw new Error('NovelAI 官方接口尚未配置 Token');
        return { ...config, model: task.model || config.model, provider: 'official' } as NaiImageConfig;
    }
    const config = saved.naiThirdParty || (saved.nai?.provider === 'thirdparty' ? saved.nai : null);
    if (!config?.apiKey?.trim()) throw new Error('NAI 第三方接口尚未配置 Token');
    return { ...config, model: task.model || config.model, provider: 'thirdparty' } as NaiImageConfig;
}

async function loadStandardReferenceImage(task: VisualTask, profileBaseAssetId?: string): Promise<Blob | null> {
    const referenceAssetId = resolveVisualReferenceAssetId(task.referenceAssetIds, profileBaseAssetId);
    if (!referenceAssetId) return null;

    const asset = await visualCompanionRepository.getAsset(referenceAssetId);
    if (!asset || asset.charId !== task.charId || asset.status !== 'ready' || asset.privacyScope !== 'standard' || asset.storage.kind !== 'blobref') {
        throw new Error('角色基础形象图片不可用，已停止生成以避免丢失形象锚点');
    }
    const blob = await getBlobForRef(asset.storage.ref);
    if (!blob || !blob.type.startsWith('image/')) {
        throw new Error('角色基础形象图片文件缺失或格式无效');
    }
    return blob;
}

async function generateForTask(task: VisualTask): Promise<Blob> {
    const config = getProviderConfig(task);
    const appearanceProfile = await visualCompanionRepository.getProfile('visual_profile_' + encodeURIComponent(task.charId));
    const visualMemories = await visualCompanionRepository.listMemories(task.charId);
    const effectivePrompt = mergeCharacterVisualContextPrompt(task.prompt, appearanceProfile, visualMemories);
    if (task.provider === 'openai' || task.provider === 'openai_compatible') {
        const referenceImage = await loadStandardReferenceImage(task, appearanceProfile?.baseAssetId);
        if (referenceImage) {
            return editGptImage(config as GptImageConfig, referenceImage, effectivePrompt, {
                size: '1024x1024',
                quality: 'high',
            });
        }
        return generateGptImage(config as GptImageConfig, effectivePrompt, {
            size: '1024x1024',
            quality: 'high',
        });
    }
    const naiConfig = config as NaiImageConfig;
    const negativePrompt = task.negativePrompt || 'low quality, worst quality, blurry, bad anatomy';
    return generateNaiImage(naiConfig, effectivePrompt, negativePrompt, {
        width: 832,
        height: 1216,
        steps: 28,
        scale: 5,
        sampler: 'k_euler_ancestral',
    });
}

/**
 * Execute or resume a single visual task in the foreground.
 * Repeated calls are harmless: state transitions and chat delivery are idempotent.
 */
async function runVisualTaskInForeground(taskId: string): Promise<VisualTask | null> {
    let task = await visualCompanionRepository.getTask(taskId);
    if (!task) return null;

    try {
        if (task.status === 'queued') {
            try {
                task = await visualCompanionRepository.transitionTask(taskId, 'planning');
            } catch {
                return visualCompanionRepository.getTask(taskId);
            }
        } else if (task.status === 'retry_wait') {
            if (task.nextAttemptAt && task.nextAttemptAt > Date.now()) return task;
            task = await resumeVisualTaskRetry(taskId);
        } else if (!['planning', 'generating', 'persisting', 'delivery_pending'].includes(task.status)) {
            return task;
        }

        if (task.status === 'planning') {
            task = await startVisualGeneration(task.id);
        }

        if (task.status === 'generating') {
            const image = await generateForTask(task);
            const blobRef = await putImageBlob(image);
            const assetId = `visual_asset_${encodeURIComponent(task.id)}`;
            await visualCompanionRepository.saveAsset({
                id: assetId,
                charId: task.charId,
                status: 'ready',
                privacyScope: 'standard',
                storage: { kind: 'blobref', ref: blobRef },
                mimeType: image.type || 'image/png',
                byteSize: image.size,
                taskId: task.id,
                createdAt: Date.now(),
            });
            task = await recordGeneratedVisualAssets(task.id, [assetId]);
        }

        if (task.status === 'persisting') {
            const assetId = task.resultAssetIds[0];
            const asset = assetId ? await visualCompanionRepository.getAsset(assetId) : null;
            if (!asset || asset.privacyScope !== 'standard' || asset.storage.kind !== 'blobref') {
                throw new Error('生成图片的本地资产记录缺失，无法安全投递');
            }
            task = await markVisualAssetsPersisted(task.id);
        }

        if (task.status === 'delivery_pending') {
            const assetId = task.resultAssetIds[0];
            const asset = assetId ? await visualCompanionRepository.getAsset(assetId) : null;
            if (!asset || asset.privacyScope !== 'standard' || asset.storage.kind !== 'blobref') {
                throw new Error('待投递图片资产不存在或不是标准资产');
            }
            const delivered = await deliverVisualTaskToChat(task.id, asset.storage.ref);
            window.dispatchEvent(new CustomEvent('active-msg-progress', {
                detail: { charId: task.charId },
            }));
            return delivered.task;
        }

        return task;
    } catch (error) {
        const latest = await visualCompanionRepository.getTask(task.id);
        const message = error instanceof Error ? error.message : String(error);
        if (latest && ['generating', 'persisting', 'delivery_pending'].includes(latest.status)) {
            const retryStage = latest.status;
            const attempt = latest.attempt + 1;
            if (attempt < latest.maxAttempts) {
                await visualCompanionRepository.transitionTask(task.id, 'retry_wait', {
                    attempt,
                    retryStage: retryStage as 'generating' | 'persisting' | 'delivery_pending',
                    nextAttemptAt: Date.now() + 30_000,
                    errorCode: 'foreground_execution_failed',
                    errorMessage: message.slice(0, 300),
                });
                if (typeof window !== 'undefined') {
                    window.setTimeout(() => {
                        void executeVisualTaskInForeground(task.id).catch(retryError => {
                            console.warn('[VisualCompanion] foreground retry failed', { taskId: task.id, error: retryError });
                        });
                    }, 30_500);
                }
            } else {
                await visualCompanionRepository.transitionTask(task.id, 'failed', {
                    attempt,
                    errorCode: 'foreground_execution_failed',
                    errorMessage: message.slice(0, 300),
                });
            }
        } else if (latest?.status === 'planning') {
            await visualCompanionRepository.transitionTask(task.id, 'failed', {
                errorCode: 'foreground_setup_failed',
                errorMessage: message.slice(0, 300),
            });
        }
        console.warn('[VisualCompanion] foreground task failed', { taskId, error });
        return visualCompanionRepository.getTask(task.id);
    }
}


/**
 * Deduplicate foreground execution inside one page session.
 * A task can be resumed from the settings/history panel while its original
 * trigger is still running; sharing one promise prevents duplicate provider calls.
 */
const inFlightVisualTasks = new Map<string, Promise<VisualTask | null>>();

export function executeVisualTaskInForeground(taskId: string): Promise<VisualTask | null> {
    const existing = inFlightVisualTasks.get(taskId);
    if (existing) return existing;

    const execution = runVisualTaskInForeground(taskId).finally(() => {
        if (inFlightVisualTasks.get(taskId) === execution) {
            inFlightVisualTasks.delete(taskId);
        }
    });
    inFlightVisualTasks.set(taskId, execution);
    return execution;
}
