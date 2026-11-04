import type { CharacterVisualProfile } from './types';

/**
 * Build a stable identity block for image generation.
 * Only active profiles and user-confirmed attributes are allowed into prompts.
 */
export function buildCharacterAppearancePrompt(profile: CharacterVisualProfile | null | undefined): string {
    if (!profile || profile.status !== 'active') return '';
    const legacyAttributes = (profile.identity || [])
        .filter(item => item.confirmed && item.value.trim())
        .map(item => item.value.trim());
    const description = [profile.anchorPrompt?.trim(), ...legacyAttributes].filter(Boolean).join(', ');
    if (!description) return '';
    return [
        '[Fixed character appearance]',
        'Preserve this character’s recognizable facial identity, hair, eyes, proportions and defining visual traits. Treat this as the same person in every image. Do not let the scene prompt alter these fixed traits.',
        description,
    ].join('\\n');
}

export function mergeCharacterAppearancePrompt(scenePrompt: string, profile: CharacterVisualProfile | null | undefined): string {
    const identity = buildCharacterAppearancePrompt(profile);
    return identity ? [identity, scenePrompt.trim()].filter(Boolean).join('\n\n【本次场景】\n') : scenePrompt.trim();
}
