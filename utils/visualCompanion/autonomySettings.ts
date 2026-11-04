import type { VisualAutonomySettings } from './types';

const STORAGE_PREFIX = 'sully-visual-autonomy:v1:';

/** Safe first-run defaults: no unsolicited generation or private creation until explicitly enabled. */
export function createDefaultVisualAutonomySettings(now = Date.now()): VisualAutonomySettings {
    return {
        enabled: false,
        frequency: 'natural',
        allowSpontaneousShare: false,
        allowPrivateCreation: false,
        requireApprovalForNewIdentity: true,
        dailyImageLimit: 3,
        updatedAt: now,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSettings(value: unknown, now: number): VisualAutonomySettings {
    const defaults = createDefaultVisualAutonomySettings(now);
    if (!isRecord(value)) return defaults;
    const frequency = value.frequency;
    return {
        enabled: value.enabled === true,
        frequency: frequency === 'low' || frequency === 'natural' || frequency === 'high' || frequency === 'paused'
            ? frequency : defaults.frequency,
        allowSpontaneousShare: value.allowSpontaneousShare === true,
        allowPrivateCreation: value.allowPrivateCreation === true,
        requireApprovalForNewIdentity: value.requireApprovalForNewIdentity !== false,
        dailyImageLimit: typeof value.dailyImageLimit === 'number' && Number.isInteger(value.dailyImageLimit) && value.dailyImageLimit >= 0
            ? Math.min(Number(value.dailyImageLimit), 100) : defaults.dailyImageLimit,
        dailyCreditLimit: typeof value.dailyCreditLimit === 'number' && Number.isFinite(value.dailyCreditLimit) && value.dailyCreditLimit >= 0
            ? value.dailyCreditLimit : undefined,
        quietHours: isRecord(value.quietHours)
            && typeof value.quietHours.start === 'string'
            && typeof value.quietHours.end === 'string'
            ? { start: value.quietHours.start, end: value.quietHours.end }
            : undefined,
        updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : now,
    };
}

export function loadVisualAutonomySettings(charId: string): VisualAutonomySettings {
    if (!charId.trim()) return createDefaultVisualAutonomySettings();
    try {
        const raw = localStorage.getItem(STORAGE_PREFIX + encodeURIComponent(charId));
        return raw ? normalizeSettings(JSON.parse(raw), Date.now()) : createDefaultVisualAutonomySettings();
    } catch {
        return createDefaultVisualAutonomySettings();
    }
}

export function saveVisualAutonomySettings(
    charId: string,
    settings: VisualAutonomySettings,
): VisualAutonomySettings {
    if (!charId.trim()) throw new Error('charId 不能为空');
    const normalized = normalizeSettings({ ...settings, updatedAt: Date.now() }, Date.now());
    try {
        localStorage.setItem(STORAGE_PREFIX + encodeURIComponent(charId), JSON.stringify(normalized));
    } catch {
        throw new Error('视觉主动分享设置保存失败，请检查浏览器存储空间或隐私模式限制');
    }
    return normalized;
}

export function resetVisualAutonomySettings(charId: string): VisualAutonomySettings {
    if (!charId.trim()) throw new Error('charId 不能为空');
    try {
        localStorage.removeItem(STORAGE_PREFIX + encodeURIComponent(charId));
    } catch {
        throw new Error('视觉主动分享设置重置失败');
    }
    return createDefaultVisualAutonomySettings();
}
