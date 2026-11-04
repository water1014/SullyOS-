export interface TavernPresetPrompt {
    identifier?: string;
    name?: string;
    role?: string;
    content?: string;
    system_prompt?: boolean;
    marker?: boolean;
    injection_position?: number;
    injection_depth?: number;
    injection_order?: number;
    injection_trigger?: string[];
    forbid_overrides?: boolean;
    [key: string]: unknown;
}

export interface TavernPresetPromptOrderItem {
    identifier: string;
    enabled: boolean;
    [key: string]: unknown;
}

export interface TavernPresetPromptOrder {
    character_id?: number | string;
    order: TavernPresetPromptOrderItem[];
    [key: string]: unknown;
}

export interface TavernPromptPreset {
    name: string;
    prompts: TavernPresetPrompt[];
    prompt_order: TavernPresetPromptOrder[];
    raw: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const isTavernPromptPreset = (value: unknown): boolean => {
    if (!isRecord(value) || !Array.isArray(value.prompts)) return false;
    return value.prompts.some(item => isRecord(item) && (
        typeof item.identifier === 'string' || typeof item.name === 'string'
    ));
};

/**
 * Parse a SillyTavern prompt preset (not a worldbook).
 * Keep the complete source object so unknown fields and future extensions
 * can be retained when the preset is saved/exported again.
 */
export const parseTavernPromptPreset = (
    rawText: string,
    fileName = '导入提示词预设',
): TavernPromptPreset => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawText);
    } catch {
        throw new Error('JSON 文件无法解析，请确认文件没有损坏');
    }

    if (!isTavernPromptPreset(parsed)) {
        throw new Error('不是受支持的酒馆提示词预设：未找到 prompts 提示词列表。世界书请在「世界书」中导入。');
    }

    const prompts = (parsed.prompts as unknown[]).filter(isRecord) as TavernPresetPrompt[];
    if (prompts.length === 0) {
        throw new Error('提示词预设中没有有效的 prompts 条目');
    }

    const promptOrder = Array.isArray(parsed.prompt_order)
        ? parsed.prompt_order.filter(isRecord).map((item): TavernPresetPromptOrder => ({
            ...item,
            order: Array.isArray(item.order)
                ? item.order.filter(isRecord).filter(entry => typeof entry.identifier === 'string').map(entry => ({
                    ...entry,
                    identifier: String(entry.identifier),
                    enabled: entry.enabled !== false,
                }))
                : [],
        }))
        : [];

    const baseName = fileName.replace(/\.json$/i, '').trim();
    return {
        name: typeof parsed.name === 'string' && parsed.name.trim()
            ? parsed.name.trim()
            : baseName || '导入提示词预设',
        prompts,
        prompt_order: promptOrder,
        raw: parsed,
    };
};
