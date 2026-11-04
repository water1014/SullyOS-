/**
 * 宋祁视觉任务编排器 · 本地任务生命周期
 *
 * 本模块只负责任务元数据和状态推进，不调用图像 Provider、不保存图片二进制、
 * 不处理 API Key。真正的后台可靠执行和跨设备调度仍需云端队列适配器。
 */
import { visualCompanionRepository } from './repository';
import type { VisualTask, VisualTaskStatus } from './types';
import { evaluateVisualAutonomy, type VisualAutonomyContext } from './autonomyPolicy';
import type { VisualAutonomySettings } from './types';

function createId(prefix: string): string {
    const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    return `${prefix}_${random}`;
}

function retryStageFor(status: VisualTaskStatus): 'generating' | 'persisting' | 'delivery_pending' {
    if (status === 'generating' || status === 'persisting' || status === 'delivery_pending') return status;
    throw new Error('当前任务阶段不支持自动重试：' + status);
}

/** 创建任务。显式传入的 deliveryId 可用于调用方重试创建时保持幂等。 */
export async function createVisualTask(
    input: Omit<VisualTask, 'id' | 'status' | 'deliveryId' | 'attempt' | 'createdAt' | 'updatedAt' | 'resultAssetIds' | 'retryStage'> & {
        deliveryId?: string;
        status?: never;
    }
): Promise<VisualTask> {
    const deliveryId = input.deliveryId || createId('visual_delivery');
    const now = Date.now();
    if (!input.charId.trim()) throw new Error('charId 不能为空');
    if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) throw new Error('maxAttempts 必须是正整数');
    const taskId = 'visual_task_' + encodeURIComponent(deliveryId);
    const task: VisualTask = {
        ...input,
        id: taskId,
        status: 'queued',
        deliveryId,
        attempt: 0,
        resultAssetIds: [],
        createdAt: now,
        updatedAt: now,
    };
    try {
        await visualCompanionRepository.createTaskOnce(task);
        return task;
    } catch (error) {
        // 相同 deliveryId 映射到相同任务 ID；并发重复请求只返回已创建的任务。
        const existing = await visualCompanionRepository.getTask(taskId);
        if (existing && existing.deliveryId === deliveryId && existing.charId === input.charId) return existing;
        throw error;
    }
}

/** Apply the autonomy policy before a spontaneous-share task can enter the queue. */
export async function createAutonomousVisualTask(
    settings: VisualAutonomySettings,
    context: VisualAutonomyContext,
    input: Omit<VisualTask, 'id' | 'status' | 'deliveryId' | 'attempt' | 'createdAt' | 'updatedAt' | 'resultAssetIds' | 'retryStage'>
): Promise<{ decision: ReturnType<typeof evaluateVisualAutonomy>; task?: VisualTask }> {
    if (input.kind !== 'spontaneous_share') {
        throw new Error('自主分享入口只接受 spontaneous_share 任务');
    }
    const decision = evaluateVisualAutonomy(settings, context);
    if (!decision.allowed) return { decision };
    const task = await createVisualTask(input);
    return { decision, task };
}

/** 抢占一个排队任务。IndexedDB 写事务中的状态检查可避免同一任务被重复认领。 */
export async function claimNextVisualTask(charId: string): Promise<VisualTask | null> {
    const queued = (await visualCompanionRepository.listTasks(charId))
        .filter(task => task.status === 'queued')
        .sort((a, b) => a.createdAt - b.createdAt);
    for (const task of queued) {
        try {
            return await visualCompanionRepository.transitionTask(task.id, 'planning');
        } catch (error) {
            // 另一个执行器可能已先认领；继续尝试下一条。
            if (!(error instanceof Error) || !error.message.includes('不允许的视觉任务状态转换')) throw error;
        }
    }
    return null;
}

export function startVisualGeneration(taskId: string): Promise<VisualTask> {
    return visualCompanionRepository.transitionTask(taskId, 'generating');
}

/** Provider 已返回图片引用，先记录结果，再进入资产持久化阶段。 */
export function recordGeneratedVisualAssets(taskId: string, assetIds: string[]): Promise<VisualTask> {
    if (!assetIds.length || assetIds.some(id => !id.trim())) {
        throw new Error('生成结果必须包含有效的资产 ID');
    }
    return visualCompanionRepository.transitionTask(taskId, 'persisting', {
        resultAssetIds: [...new Set(assetIds)],
        errorCode: undefined,
        errorMessage: undefined,
        nextAttemptAt: undefined,
        retryStage: undefined,
    });
}

/** 标准/私密资产适配器完成各自的安全保存后，进入聊天投递阶段。 */
export function markVisualAssetsPersisted(taskId: string): Promise<VisualTask> {
    return visualCompanionRepository.transitionTask(taskId, 'delivery_pending', {
        errorCode: undefined,
        errorMessage: undefined,
        nextAttemptAt: undefined,
        retryStage: undefined,
    });
}

/** 投递成功后才标记 delivered。调用方应使用 task.deliveryId 做消息幂等。 */
export function markVisualTaskDelivered(taskId: string, messageId?: number): Promise<VisualTask> {
    return visualCompanionRepository.transitionTask(taskId, 'delivered', {
        completedAt: Date.now(),
        deliveredMessageId: messageId,
        errorCode: undefined,
        errorMessage: undefined,
        nextAttemptAt: undefined,
        retryStage: undefined,
    });
}

/**
 * 记录失败检查点。delivery_pending 的失败会保存为 delivery_pending，
 * 恢复时只回到投递阶段，不会回到 generating。
 */
export async function scheduleVisualTaskRetry(
    taskId: string,
    error: { code: string; message: string },
    nextAttemptAt: number
): Promise<VisualTask> {
    const task = await visualCompanionRepository.getTask(taskId);
    if (!task) throw new Error('视觉任务不存在：' + taskId);
    const retryStage = retryStageFor(task.status);
    const attempt = task.attempt + 1;
    if (attempt >= task.maxAttempts) {
        return visualCompanionRepository.transitionTask(taskId, 'failed', {
            attempt,
            errorCode: error.code,
            errorMessage: error.message,
            nextAttemptAt: undefined,
            retryStage: undefined,
        });
    }
    if (!Number.isFinite(nextAttemptAt) || nextAttemptAt < Date.now()) {
        throw new Error('重试时间必须是当前时间之后的有效时间戳');
    }
    return visualCompanionRepository.transitionTask(taskId, 'retry_wait', {
        attempt,
        errorCode: error.code,
        errorMessage: error.message,
        nextAttemptAt,
        retryStage,
    });
}

/** 仅恢复到失败前的阶段；尤其 delivery_pending 只重试投递，不重新生成。 */
export async function resumeVisualTaskRetry(taskId: string, now = Date.now()): Promise<VisualTask> {
    const task = await visualCompanionRepository.getTask(taskId);
    if (!task) throw new Error('视觉任务不存在：' + taskId);
    if (task.status !== 'retry_wait' || !task.retryStage) {
        throw new Error('任务没有可恢复的重试检查点');
    }
    if (task.nextAttemptAt && task.nextAttemptAt > now) {
        throw new Error('重试时间尚未到达');
    }
    const stage = task.retryStage;
    return visualCompanionRepository.transitionTask(taskId, stage, {
        nextAttemptAt: undefined,
        retryStage: undefined,
        errorCode: undefined,
        errorMessage: undefined,
    });
}

export function cancelVisualTask(taskId: string): Promise<VisualTask> {
    return visualCompanionRepository.transitionTask(taskId, 'cancelled', {
        nextAttemptAt: undefined,
        retryStage: undefined,
    });
}

/** 用户批准等待确认的任务后，重新进入队列等待认领。 */
export function approveVisualTask(taskId: string): Promise<VisualTask> {
    return visualCompanionRepository.transitionTask(taskId, 'queued');
}
