import { describe, expect, it } from 'vitest';
import { isTavernPromptPreset, parseTavernPromptPreset, readActiveTavernPromptPreset, renderTavernPromptPreset } from './tavernPromptPreset';

describe('SillyTavern prompt preset import', () => {
    const sample = {
        extensions: {},
        temperature: 2,
        wi_format: '{0}',
        prompts: [
            { name: '系统', identifier: 'main', role: 'system', system_prompt: true, content: '系统规则', injection_position: 0, injection_depth: 4, injection_order: 100, injection_trigger: [], forbid_overrides: false },
            { name: 'Auxiliary Prompt', identifier: 'nsfw', role: 'system', system_prompt: true, content: '' },
            { name: 'Chat Examples', identifier: 'dialogueExamples', system_prompt: true, marker: true },
        ],
        prompt_order: [
            { character_id: 100000, order: [{ identifier: 'main', enabled: true }, { identifier: 'nsfw', enabled: true }, { identifier: 'dialogueExamples', enabled: false }] },
        ],
    };

    it('recognizes a preset by its prompts array, not as a worldbook', () => {
        expect(isTavernPromptPreset(sample)).toBe(true);
        expect(isTavernPromptPreset({ entries: [] })).toBe(false);
    });

    it('preserves prompt definitions, prompt order, and unknown top-level settings', () => {
        const imported = parseTavernPromptPreset(JSON.stringify(sample), 'deepseek v4 纯破限 0.1.json');
        expect(imported.name).toBe('deepseek v4 纯破限 0.1');
        expect(imported.prompts).toHaveLength(3);
        expect(imported.prompts[0]).toMatchObject({
            identifier: 'main',
            content: '系统规则',
            injection_position: 0,
            injection_depth: 4,
            injection_order: 100,
        });
        expect(imported.prompt_order[0].order).toEqual([
            { identifier: 'main', enabled: true },
            { identifier: 'nsfw', enabled: true },
            { identifier: 'dialogueExamples', enabled: false },
        ]);
        expect(imported.raw).toMatchObject({ temperature: 2, wi_format: '{0}', extensions: {} });
    });

    it('honors prompt_order enabled flags in the editor model and generated prompt', () => {
        const source = {
            name: '开关测试',
            prompts: [
                { identifier: 'keep', name: '保留模块', role: 'system', content: '应该发送' },
                { identifier: 'skip', name: '关闭模块', role: 'system', content: '不应该发送' },
            ],
            prompt_order: [
                { character_id: 100000, order: [
                    { identifier: 'keep', enabled: true },
                    { identifier: 'skip', enabled: false },
                ] },
            ],
        };
        const preset = parseTavernPromptPreset(JSON.stringify(source));
        expect(preset.prompts.map(prompt => prompt.enabled)).toEqual([true, false]);
        const rendered = renderTavernPromptPreset(preset);
        expect(rendered).toContain('应该发送');
        expect(rendered).not.toContain('不应该发送');
    });


    it('reads only the locally selected preset for chat injection', () => {
        localStorage.clear();
        const first = parseTavernPromptPreset(JSON.stringify({
            name: '已启用',
            prompts: [{ identifier: 'a', name: '核心补充', role: 'system', content: '注入内容' }],
            prompt_order: [{ order: [{ identifier: 'a', enabled: true }] }],
        }));
        const second = parseTavernPromptPreset(JSON.stringify({
            name: '未启用',
            prompts: [{ identifier: 'b', name: '不应注入', role: 'system', content: '不应出现' }],
            prompt_order: [{ order: [{ identifier: 'b', enabled: true }] }],
        }));
        localStorage.setItem('sully-tavern-prompt-presets:v1', JSON.stringify([first, second]));
        localStorage.setItem('sully-tavern-prompt-preset-active:v1', '已启用');

        expect(readActiveTavernPromptPreset()).toContain('注入内容');
        expect(readActiveTavernPromptPreset()).not.toContain('不应出现');
        localStorage.clear();
    });

    it('allows manually re-enabling a module disabled in the imported order', () => {
        const source = {
            name: '手动开关',
            prompts: [
                { identifier: 'a', name: '默认启用', role: 'system', content: 'A' },
                { identifier: 'b', name: '原本关闭', role: 'system', content: 'B', enabled: false },
            ],
            prompt_order: [{ order: [
                { identifier: 'a', enabled: true },
                { identifier: 'b', enabled: false },
            ] }],
        };
        const preset = parseTavernPromptPreset(JSON.stringify(source));
        preset.manualOrder = true;
        preset.prompts[1].enabled = true;
        expect(renderTavernPromptPreset(preset)).toContain('B');
    });

    it('gives a clear message when a worldbook is passed to the preset importer', () => {
        expect(() => parseTavernPromptPreset(JSON.stringify({ entries: [] }))).toThrow(/prompts/);
    });
});
