import { describe, expect, it } from 'vitest';
import { buildCharacterAppearancePrompt, buildCharacterVisualChangePrompt, mergeCharacterAppearancePrompt, mergeCharacterVisualContextPrompt } from './identityPrompt';
import type { VisualMemoryRecord } from './types';
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


describe('character visual change timeline', () => {
    const memory = (overrides: Partial<VisualMemoryRecord>): VisualMemoryRecord => ({
        id: 'm1', charId: 'c1', status: 'confirmed', source: 'user', category: 'appearance',
        content: '雨水打湿的黑色长发', locked: true, privacyScope: 'standard',
        visualChangeKind: 'temporary', createdAt: 1, updatedAt: 1, ...overrides,
    });

    it('includes confirmed permanent changes and active temporary context separately', () => {
        const prompt = buildCharacterVisualChangePrompt([
            memory({ id: 'permanent', content: '右眉新增一道浅疤', visualChangeKind: 'permanent', activeUntil: undefined }),
            memory({ id: 'temporary', content: '雨水打湿头发', activeUntil: 500 }),
        ], 100);
        expect(prompt).toContain('[Confirmed permanent visual changes]');
        expect(prompt).toContain('右眉新增一道浅疤');
        expect(prompt).toContain('[Temporary appearance for the current scene only]');
        expect(prompt).toContain('雨水打湿头发');
        expect(prompt).toContain('Do not save these temporary conditions');
    });

    it('excludes expired, unconfirmed and private visual changes', () => {
        const prompt = buildCharacterVisualChangePrompt([
            memory({ id: 'expired', activeUntil: 99 }),
            memory({ id: 'draft', status: 'proposed', content: '未确认的新发色' }),
            memory({ id: 'private', privacyScope: 'private', content: '私密造型' }),
        ], 100);
        expect(prompt).toBe('');
    });

    it('keeps fixed identity first, visual timeline second and scene last', () => {
        const prompt = mergeCharacterVisualContextPrompt('海边黄昏', profile, [
            memory({ id: 'permanent', visualChangeKind: 'permanent', content: '右耳耳钉' }),
        ], 100);
        expect(prompt.indexOf('[Fixed character appearance]')).toBeLessThan(prompt.indexOf('[Confirmed permanent visual changes]'));
        expect(prompt.indexOf('[Confirmed permanent visual changes]')).toBeLessThan(prompt.indexOf('海边黄昏'));
    });
});
