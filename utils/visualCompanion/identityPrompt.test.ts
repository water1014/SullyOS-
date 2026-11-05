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

    it('deduplicates repeated appearance details from legacy and canonical fields', () => {
        const prompt = buildCharacterAppearancePrompt({
            ...profile,
            anchorPrompt: '黑色长发',
            identity: [
                { key: 'hair', value: '黑色长发', confirmed: true, source: 'user', updatedAt: 1 },
                { key: 'eyes', value: '灰蓝色眼睛', confirmed: true, source: 'user', updatedAt: 1 },
            ],
        });
        expect(prompt.match(/黑色长发/g)).toHaveLength(1);
        expect(prompt.match(/灰蓝色眼睛/g)).toHaveLength(1);
    });

    it('allows explicit scene hairstyle changes without weakening facial identity', () => {
        const prompt = mergeCharacterAppearancePrompt('本次场景：短发，黑色皮衣', profile);
        expect(prompt).toContain('recognizable facial identity');
        expect(prompt).toContain('when the current scene explicitly requests a different hairstyle');
        expect(prompt).toContain('本次场景：短发，黑色皮衣');
        expect(prompt).toContain('Do not let a temporary scene change overwrite the saved permanent appearance profile.');
    });

    it('keeps the scene prompt after the fixed identity block', () => {
        const prompt = mergeCharacterAppearancePrompt('雨夜里的咖啡馆', profile);
        expect(prompt.indexOf('黑色长发')).toBeLessThan(prompt.indexOf('雨夜里的咖啡馆'));
        expect(prompt).toContain('【本次场景】');
    });

    it('replaces stale identity context when a reroll reuses the previous positive prompt', () => {
        const previous = mergeCharacterVisualContextPrompt('雨夜里的咖啡馆', profile, []);
        const updatedProfile = { ...profile, anchorPrompt: '银白色短发，琥珀色眼睛', identity: [] };
        const rerolled = mergeCharacterVisualContextPrompt(previous, updatedProfile, []);
        expect(rerolled).toContain('银白色短发，琥珀色眼睛');
        expect(rerolled).not.toContain('黑色长发');
        expect(rerolled.split('[Fixed character appearance]').length - 1).toBe(1);
        expect(rerolled).toContain('雨夜里的咖啡馆');
    });

    it('replaces stale visual timeline blocks on reroll instead of accumulating history', () => {
        const timelineMemory = (id: string, content: string): VisualMemoryRecord => ({
            id, charId: 'c1', status: 'confirmed', source: 'user', category: 'appearance',
            content, locked: true, privacyScope: 'standard', visualChangeKind: 'permanent',
            createdAt: 1, updatedAt: 1, confirmedAt: 1,
        });
        const previous = mergeCharacterVisualContextPrompt('雨夜里的咖啡馆', profile, [
            timelineMemory('old', '旧的红色围巾'),
        ], 100);
        const rerolled = mergeCharacterVisualContextPrompt(previous, profile, [
            timelineMemory('new', '新的蓝色围巾'),
        ], 101);
        expect(rerolled).toContain('新的蓝色围巾');
        expect(rerolled).not.toContain('旧的红色围巾');
        expect(rerolled.split('[Confirmed permanent visual changes, newest first]').length - 1).toBe(1);
        expect(rerolled).toContain('雨夜里的咖啡馆');
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
        expect(prompt).toContain('[Confirmed permanent visual changes, newest first]');
        expect(prompt).toContain('右眉新增一道浅疤');
        expect(prompt).toContain('[Temporary appearance for the current scene only, newest first]');
        expect(prompt).toContain('雨水打湿头发');
        expect(prompt).toContain('must not overwrite permanent identity');
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
        expect(prompt.indexOf('[Fixed character appearance]')).toBeLessThan(prompt.indexOf('[Confirmed permanent visual changes, newest first]'));
        expect(prompt.indexOf('[Confirmed permanent visual changes]')).toBeLessThan(prompt.indexOf('海边黄昏'));
    });

    it('orders visual history newest first and explains conflict precedence', () => {
        const prompt = buildCharacterVisualChangePrompt([
            memory({ id: 'older', content: '短发', visualChangeKind: 'permanent', confirmedAt: 10 }),
            memory({ id: 'newer', content: '及肩长发', visualChangeKind: 'permanent', confirmedAt: 20 }),
            memory({ id: 'duplicate', content: '及肩长发', visualChangeKind: 'permanent', confirmedAt: 15 }),
        ], 100);
        expect(prompt.indexOf('及肩长发')).toBeLessThan(prompt.indexOf('短发'));
        expect(prompt.match(/及肩长发/g)).toHaveLength(1);
        expect(prompt).toContain('newer confirmed note takes precedence');
    });
});
