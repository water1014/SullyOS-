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
    // Older profiles may repeat the same detail in both anchorPrompt and identity[].
    const seen = new Set<string>();
    const descriptionParts = [profile.anchorPrompt?.trim(), ...legacyAttributes]
        .map(value => value?.replace(/\s+/g, ' ').trim() || '')
        .filter(value => {
            if (!value) return false;
            const key = value.toLocaleLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    const description = descriptionParts.join(', ');
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
    // Keep the timeline deterministic. Newer confirmations lead, so the model can resolve
    // conflicting historical notes without silently discarding independent details.
    const newestFirst = (items: typeof eligible) => {
        const seen = new Set<string>();
        return [...items]
            .sort((a, b) =>
                (b.confirmedAt ?? b.updatedAt ?? b.createdAt) - (a.confirmedAt ?? a.updatedAt ?? a.createdAt)
                || b.createdAt - a.createdAt
                || a.id.localeCompare(b.id),
            )
            .filter(item => {
                const key = item.content.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
    };
    const permanent = newestFirst(eligible.filter(memory => memory.visualChangeKind === 'permanent'));
    const temporary = newestFirst(eligible.filter(memory => memory.visualChangeKind === 'temporary'));
    const blocks = [
        permanent.length
            ? '[Confirmed permanent visual changes, newest first]\n' + permanent.map(item => item.content.trim()).join('\n') + '\nPreserve all compatible permanent details. When two notes conflict, the newer confirmed note takes precedence.'
            : '',
        temporary.length
            ? '[Temporary appearance for the current scene only, newest first]\n' + temporary.map(item => item.content.trim()).join('\n') + '\nUse the newest temporary note when temporary notes conflict. These conditions apply only to this image and must not overwrite permanent identity.'
            : '',
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
    // Reroll controls may pass the previous fully-composed positive prompt.
    // Strip its old identity/timeline blocks so the latest confirmed profile is
    // injected exactly once and edits to the profile take effect immediately.
    const priorContextMarker = '[Fixed character appearance]';
    const sceneOnly = scenePrompt.includes(priorContextMarker)
        ? (scenePrompt.split('【本次场景】').slice(1).join('【本次场景】').trim() || scenePrompt.trim())
        : scenePrompt.trim();
    return [identity, changes, sceneOnly].filter(Boolean).join('\n\n');
}
