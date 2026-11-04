/**
 * 宋祁视觉人格系统 · 领域类型（P1 数据层）
 *
 * 这里只定义稳定的数据契约，不在此文件中访问 IndexedDB、网络或 Provider。
 * 任何持久化实现都必须遵循 privacyScope 与状态机约束。
 */

export type VisualPrivacyScope = 'standard' | 'private';

export type VisualTaskStatus =
    | 'queued'
    | 'planning'
    | 'awaiting_approval'
    | 'generating'
    | 'persisting'
    | 'delivery_pending'
    | 'delivered'
    | 'retry_wait'
    | 'cancelled'
    | 'failed';

export type VisualTaskKind =
    | 'spontaneous_share'
    | 'chat_requested'
    | 'photo_project'
    | 'regenerate_shot'
    | 'additional_shot';

export type VisualProviderKind =
    | 'openai'
    | 'openai_compatible'
    | 'novelai_official'
    | 'novelai_compatible';

export type VisualMemoryStatus = 'proposed' | 'confirmed' | 'rejected' | 'archived';
export type VisualMemorySource = 'user' | 'character' | 'image_inference' | 'conversation' | 'project';
export type VisualAssetStatus = 'staging' | 'ready' | 'missing' | 'deleted';
export type VisualShotStatus = 'planned' | 'generating' | 'ready' | 'needs_retry' | 'skipped';

export interface VisualIdentityAttribute {
    key: string;
    value: string;
    /** 是否已由用户确认；推断信息必须为 false。 */
    confirmed: boolean;
    source: 'user' | 'character_profile' | 'inference';
    confidence?: number;
    locked?: boolean;
    updatedAt: number;
}

export interface CharacterVisualProfile {
    id: string;
    charId: string;
    version: number;
    status: 'draft' | 'awaiting_confirmation' | 'active' | 'archived';
    /** 稳定身份锚点，例如脸型、发色、瞳色、体态、画风。 */
    identity: VisualIdentityAttribute[];
    /** 不可被单次场景提示词覆盖的身份约束。 */
    anchorPrompt: string;
    /** 当前确认的基础形象资产，不保存 data URL 或 API 凭据。 */
    baseAssetId?: string;
    confirmedAt?: number;
    createdAt: number;
    updatedAt: number;
}

export interface VisualMemoryRecord {
    id: string;
    charId: string;
    status: VisualMemoryStatus;
    source: VisualMemorySource;
    /** 例如 hairstyle、outfit_preference、scar、visual_style。 */
    category: string;
    content: string;
    confidence?: number;
    evidenceAssetIds?: string[];
    evidenceMessageIds?: number[];
    /** true 表示用户锁定，自动整理不得覆盖或删除。 */
    locked: boolean;
    privacyScope: VisualPrivacyScope;
    createdAt: number;
    updatedAt: number;
    confirmedAt?: number;
}

export interface VisualTaskBudget {
    estimatedCredits?: number;
    maxCredits?: number;
    maxImages?: number;
    currency?: string;
}

export interface VisualTask {
    id: string;
    charId: string;
    kind: VisualTaskKind;
    status: VisualTaskStatus;
    privacyScope: VisualPrivacyScope;
    /** 只存 Provider 配置引用，不存 API Key / 自定义请求头明文。 */
    provider: VisualProviderKind;
    providerConfigId: string;
    model: string;
    prompt: string;
    negativePrompt?: string;
    referenceAssetIds: string[];
    projectId?: string;
    shotId?: string;
    /** 触发来源只记录引用，不复制整段聊天正文。 */
    sourceMessageId?: number;
    sourceEventId?: string;
    deliveryId: string;
    attempt: number;
    maxAttempts: number;
    budget: VisualTaskBudget;
    resultAssetIds: string[];
    errorCode?: string;
    errorMessage?: string;
    nextAttemptAt?: number;
    /** retry_wait 恢复时回到的阶段，确保投递失败不会重新生成图片。 */
    retryStage?: 'generating' | 'persisting' | 'delivery_pending';
    createdAt: number;
    updatedAt: number;
    completedAt?: number;
}

export interface VisualAssetRecordBase {
    id: string;
    charId: string;
    status: VisualAssetStatus;
    mimeType: string;
    byteSize: number;
    width?: number;
    height?: number;
    checksum?: string;
    taskId?: string;
    projectId?: string;
    shotId?: string;
    sourceMessageId?: number;
    createdAt: number;
    deletedAt?: number;
}

/**
 * 用判别联合在编译期阻止私密资产误接入普通 blobref/GC。
 * 私密资产必须带密钥版本，且只能指向独立私密存储。
 */
export type VisualAssetRecord = VisualAssetRecordBase & (
    | {
        privacyScope: 'standard';
        storage: { kind: 'blobref'; ref: string };
        encryptionKeyVersion?: never;
    }
    | {
        privacyScope: 'private';
        storage: { kind: 'private_local' | 'private_remote'; ref: string };
        encryptionKeyVersion: number;
    }
);

export interface PhotoProjectShot {
    id: string;
    order: number;
    scene: string;
    outfit?: string;
    pose?: string;
    prompt: string;
    status: VisualShotStatus;
    assetId?: string;
    taskId?: string;
    retryCount: number;
}

export interface VisualPhotoProject {
    id: string;
    charId: string;
    title: string;
    concept: string;
    privacyScope: VisualPrivacyScope;
    status: 'draft' | 'running' | 'paused' | 'completed' | 'archived';
    shots: PhotoProjectShot[];
    createdAt: number;
    updatedAt: number;
    completedAt?: number;
}

export interface VisualAutonomySettings {
    enabled: boolean;
    /** 自然适中：日常偶尔分享，特殊情境可提高主动性。 */
    frequency: 'low' | 'natural' | 'high' | 'paused';
    allowSpontaneousShare: boolean;
    allowPrivateCreation: boolean;
    requireApprovalForNewIdentity: boolean;
    dailyImageLimit: number;
    dailyCreditLimit?: number;
    quietHours?: { start: string; end: string };
    updatedAt: number;
}

export interface VisualDeliveryRecord {
    id: string;
    deliveryId: string;
    taskId: string;
    charId: string;
    status: 'pending' | 'delivered' | 'failed';
    messageId?: number;
    attempt: number;
    createdAt: number;
    updatedAt: number;
}
