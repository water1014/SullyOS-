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
    ].join('\n');
}

export function mergeCharacterAppearancePrompt(scenePrompt: string, profile: CharacterVisualProfile | null | undefined): string {
    const identity = buildCharacterAppearancePrompt(profile);
    return identity ? [identity, scenePrompt.trim()].filter(Boolean).join('\n\n【本次场景】\n') : scenePrompt.trim();
}


export function buildCharacterVisualChangePrompt(
    memories: readonly import('./types').VisualMemoryRecord[],
    now = Date.now(),
): string {
    const eligible = memories.filter(memory =>
        memory.status === 'confirmed' &&
        memory.privacyScope === 'standard' &&
        memory.content.trim() &&
        (memory.visualChangeKind === 'permanent' ||
            (memory.visualChangeKind === 'temporary' &&
                (memory.activeUntil === undefined || memory.activeUntil > now)))
    );
    const permanent = eligible.filter(memory => memory.visualChangeKind === 'permanent');
    const temporary = eligible.filter(memory => memory.visualChangeKind === 'temporary');
    const blocks = [
        permanent.length ? '[Confirmed permanent visual changes]\n' + permanent.map(item => item.content.trim()).join('\n') : '',
        temporary.length ? '[Temporary appearance for the current scene only]\n' + temporary.map(item => item.content.trim()).join('\n') + '\nDo not save these temporary conditions as permanent identity changes.' : '',
    ].filter(Boolean);
    return blocks.join('\n\n');
}

export function mergeCharacterVisualContextPrompt(
    scenePrompt: string,
    profile: CharacterVisualProfile | null | undefined,
    memories: readonly import('./types').VisualMemoryRecord[],
    now = Date.now(),
): string {
    const identity = buildCharacterAppearancePrompt(profile);
    const changes = buildCharacterVisualChangePrompt(memories, now);
    return [identity, changes, scenePrompt.trim()].filter(Boolean).join('\n\n');
}
