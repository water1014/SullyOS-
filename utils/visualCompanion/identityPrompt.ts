import type { CharacterVisualProfile } from './types';

/**
 * Build a stable identity block for image generation.
 * Only active profiles and user-confirmed attributes are allowed into prompts.
 */
export function buildCharacterAppearancePrompt(profile: CharacterVisualProfile | null | undefined): string {
    if (!profile || profile.status !== 'active') return '';
    const attributes = (profile.identity || [])
        .filter(item => item.confirmed && item.value.trim())
        .map(item => item.value.trim());
    const extra = profile.anchorPrompt?.trim();
    const details = [...attributes, ...(extra ? [extra] : [])];
    if (!details.length) return '';
    return [
        '【固定人物外貌档案】',
        '以下内容描述同一人物不可随场景改变的外貌身份。保持脸部特征、发型发色、眼睛、体态和标志性细节一致；不要擅自改变人物身份。',
        ...details,
    ].join('\n');
}

export function mergeCharacterAppearancePrompt(scenePrompt: string, profile: CharacterVisualProfile | null | undefined): string {
    const identity = buildCharacterAppearancePrompt(profile);
    return identity ? [identity, scenePrompt.trim()].filter(Boolean).join('\n\n【本次场景】\n') : scenePrompt.trim();
}
