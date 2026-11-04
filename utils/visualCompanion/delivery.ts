/**
 * 宋祁视觉任务 → 聊天消息投递适配器
 *
 * 只负责把已保存的标准视觉资产引用投递到角色聊天。
 * 私密图片不得经过普通聊天 Blob 管线；私密投递需独立保险库和权限设计。
 */
import { DB } from '../db';
import { migrateDataUrlToRef } from '../blobRef';
import { visualCompanionRepository } from './repository';
import { markVisualTaskDelivered } from './orchestrator';
import type { VisualTask } from './types';

export interface VisualChatDeliveryResult {
    messageId: number;
    task: VisualTask;
}

/**
 * 投递已生成的图片。saveMessageOnce 以 deliveryId 保证重复调用只产生一条聊天消息。
 * imageContent 接受 data URL（会迁移到 blobref）或已持久化的 blobref。
 */
export async function deliverVisualTaskToChat(
    taskId: string,
    imageContent: string
): Promise<VisualChatDeliveryResult> {
    const task = await visualCompanionRepository.getTask(taskId);
    if (!task) throw new Error('视觉任务不存在：' + taskId);

    if (task.privacyScope !== 'standard') {
        throw new Error('私密视觉资产不能通过普通聊天投递管线发送');
    }
    if (task.status === 'delivered' && task.deliveredMessageId) {
        return { messageId: task.deliveredMessageId, task };
    }
    if (task.status !== 'delivery_pending') {
        throw new Error('视觉任务尚未进入聊天投递阶段');
    }
    if (!imageContent.trim()) throw new Error('图片内容不能为空');

    const storedContent = imageContent.startsWith('data:')
        ? await migrateDataUrlToRef(imageContent)
        : imageContent;
    if (!storedContent.startsWith('blobref:')) {
        throw new Error('聊天图片必须先保存为 blobref 资产引用');
    }

    // 不把完整提示词、Provider 凭据或私密信息复制进聊天元数据。
    const messageId = await DB.saveMessageOnce(task.deliveryId, {
        charId: task.charId,
        role: 'assistant',
        type: 'image',
        content: storedContent,
        metadata: {
            visualTaskId: task.id,
            visualTaskKind: task.kind,
            visualAssetIds: task.resultAssetIds,
            deliveryId: task.deliveryId,
        },
    });

    try {
        const delivered = await markVisualTaskDelivered(task.id, messageId);
        return { messageId, task: delivered };
    } catch (error) {
        // 并发重试可能已由另一执行器完成状态推进；核对幂等消息后返回最终记录。
        const latest = await visualCompanionRepository.getTask(task.id);
        if (latest?.status === 'delivered' && latest.deliveredMessageId) {
            return { messageId: latest.deliveredMessageId, task: latest };
        }
        throw error;
    }
}
