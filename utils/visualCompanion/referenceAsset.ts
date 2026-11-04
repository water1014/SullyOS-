/** Resolve the image anchor used by GPT image editing.
 * A task-specific reference wins; otherwise fall back to the character's confirmed base portrait.
 */
export function resolveVisualReferenceAssetId(
    taskReferenceAssetIds: readonly string[],
    profileBaseAssetId?: string,
): string | null {
    const taskReference = taskReferenceAssetIds.find(id => typeof id === 'string' && id.trim());
    if (taskReference) return taskReference;
    return profileBaseAssetId?.trim() || null;
}
