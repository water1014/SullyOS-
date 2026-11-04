import { describe, expect, it } from 'vitest';
import { buildCharacterAppearancePrompt, mergeCharacterAppearancePrompt } from './identityPrompt';
import type { CharacterVisualProfile } from './types';

const profile: CharacterVisualProfile = {
    id: 'visual_profile_c1',
    charId: 'c1',
    version: 3,
    status: 'active',
    identity: [
        { key: 'hair', value: '黑色长发', confirmed: true, source: 'user', updatedAt: 1 },
        { key: 'eyes', value: '灰蓝色眼睛', confirmed: true, source: 'user', updatedAt: 1 },
        { key: 'unconfirmed', value: '金色翅膀', confirmed: false, source: 'inference', updatedAt: 1 },
    ],
    anchorPrompt: '左眼下有一颗小痣',
    createdAt: 1,
    updatedAt: 1,
};

describe('character appearance prompt', () => {
    it('only injects active, confirmed appearance details', () => {
        const prompt = buildCharacterAppearancePrompt(profile);
        expect(prompt).toContain('黑色长发');
        expect(prompt).toContain('灰蓝色眼睛');
        expect(prompt).toContain('左眼下有一颗小痣');
        expect(prompt).toContain('[Fixed character appearance]');
        expect(prompt).not.toContain('金色翅膀');
    });

    it('uses one free-form appearance paragraph as the canonical description', () => {
        const paragraph = 'A man with silver hair, amber eyes and a small scar near his eyebrow.';
        const prompt = buildCharacterAppearancePrompt({ ...profile, identity: [], anchorPrompt: paragraph });
        expect(prompt).toContain(paragraph);
        expect(prompt).not.toContain('黑色长发');
    });

    it('does not inject draft profiles', () => {
        expect(buildCharacterAppearancePrompt({ ...profile, status: 'draft' })).toBe('');
    });

    it('keeps the scene prompt after the fixed identity block', () => {
        const prompt = mergeCharacterAppearancePrompt('雨夜里的咖啡馆', profile);
        expect(prompt.indexOf('黑色长发')).toBeLessThan(prompt.indexOf('雨夜里的咖啡馆'));
        expect(prompt).toContain('【本次场景】');
    });
});
