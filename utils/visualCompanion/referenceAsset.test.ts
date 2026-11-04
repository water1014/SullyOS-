import { describe, expect, it } from 'vitest';
import { resolveVisualReferenceAssetId } from './referenceAsset';

describe('visual reference asset resolution', () => {
    it('prefers an explicit task reference over the character base portrait', () => {
        expect(resolveVisualReferenceAssetId(['scene-ref'], 'base-portrait')).toBe('scene-ref');
    });

    it('uses the confirmed character base portrait when the task has no reference', () => {
        expect(resolveVisualReferenceAssetId([], 'base-portrait')).toBe('base-portrait');
    });

    it('ignores blank references and returns null when no anchor exists', () => {
        expect(resolveVisualReferenceAssetId(['  ', ''], '  ')).toBeNull();
    });
});
