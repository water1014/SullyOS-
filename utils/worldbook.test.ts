import { describe, expect, it } from 'vitest';
import type { MountedWorldbook, Worldbook } from '../types';
import {
    injectWorldbookDepthEntries,
    isWorldbookEntryActive,
    parseStandardWorldbook,
    resolveWorldbookEntries,
    serializeStandardWorldbook,
    splitWorldbookSections,
    toMountedWorldbook,
    upsertMountedWorldbooks,
} from './worldbook';

const book = (overrides: Partial<MountedWorldbook> = {}): MountedWorldbook => ({
    id: 'book-1',
    title: '测试条目',
    content: '{{char}} 在 {{user}} 提到月亮时会想起故乡。',
    category: '测试',
    ...overrides,
});

describe('worldbook activation', () => {
    it('keeps legacy entries constantly active after character definitions', () => {
        const resolved = resolveWorldbookEntries([book()], [], '阿澈', '小雨');
        expect(resolved).toHaveLength(1);
        expect(resolved[0].position).toBe(1);
        expect(resolved[0].content).toContain('阿澈 在 小雨');
    });

    it('activates keyword entries only when the recent scan buffer matches', () => {
        const keywordBook = book({ constant: false, key: ['月亮'], scanDepth: 2 });
        expect(isWorldbookEntryActive(keywordBook, [{ content: '今晚有月亮' }])).toBe(true);
        expect(isWorldbookEntryActive(keywordBook, [{ content: '今晚下雨' }])).toBe(false);
    });

    it('respects secondary keyword logic and disabled state', () => {
        const selectiveBook = book({
            constant: false,
            key: ['学校'],
            keysecondary: ['老师', '同学'],
            selective: true,
            selectiveLogic: 3,
        });
        expect(isWorldbookEntryActive(selectiveBook, [{ content: '学校里的老师和同学' }])).toBe(true);
        expect(isWorldbookEntryActive(selectiveBook, [{ content: '学校里的老师' }])).toBe(false);
        expect(isWorldbookEntryActive({ ...selectiveBook, disable: true }, [{ content: '学校里的老师和同学' }])).toBe(false);
    });
});

describe('worldbook positions', () => {
    it('splits standard positions and injects at-depth entries using their role', () => {
        const resolved = resolveWorldbookEntries([
            book({ id: 'before', position: 0 }),
            book({ id: 'depth', position: 4, depth: 1, role: 1 }),
        ]);
        const sections = splitWorldbookSections(resolved);
        expect(sections.beforeCharacter.map(entry => entry.book.id)).toEqual(['before']);

        const messages = injectWorldbookDepthEntries(
            [{ role: 'user', content: '一' }, { role: 'assistant', content: '二' }],
            sections.atDepth,
        );
        expect(messages.map(message => message.role)).toEqual(['user', 'user', 'assistant']);
        expect(messages[1].content).toContain('{{char}}');
    });
});

describe('standard worldbook import', () => {
    it('converts entries into a SullyOS category without losing activation metadata', () => {
        const imported = parseStandardWorldbook(JSON.stringify({
            entries: {
                0: {
                    uid: 7,
                    comment: '月亮设定',
                    content: '月亮是蓝色的。',
                    key: ['月亮'],
                    keysecondary: [],
                    constant: false,
                    selective: false,
                    order: 120,
                    position: 4,
                    depth: 2,
                    role: 0,
                    disable: false,
                    probability: 80,
                    useProbability: true,
                },
            },
        }), '导入测试', 1234);

        expect(imported).toHaveLength(1);
        expect(imported[0]).toMatchObject({
            title: '月亮设定',
            category: '导入测试',
            key: ['月亮'],
            constant: false,
            position: 4,
            depth: 2,
            role: 0,
            order: 120,
            probability: 80,
            useProbability: true,
            sourceUid: 7,
        });
    });

    it('imports SillyTavern world_info wrappers and keeps the entry activation settings', () => {
        const imported = parseStandardWorldbook(JSON.stringify({
            name: '酒馆世界书',
            world_info: {
                entries: [
                    {
                        uid: 12,
                        comment: '夜间规则',
                        content: '夜晚十点后街道关闭。',
                        key: ['夜晚', '十点'],
                        keysecondary: ['街道'],
                        constant: false,
                        selective: true,
                        selectiveLogic: 3,
                        order: 35,
                        position: 4,
                        depth: 2,
                        role: 2,
                        disable: false,
                        probability: 65,
                        useProbability: true,
                        scanDepth: 8,
                        caseSensitive: true,
                        matchWholeWords: true,
                    },
                ],
            },
        }), '酒馆导入', 4321);

        expect(imported).toHaveLength(1);
        expect(imported[0]).toMatchObject({
            title: '夜间规则',
            content: '夜晚十点后街道关闭。',
            category: '酒馆导入',
            key: ['夜晚', '十点'],
            keysecondary: ['街道'],
            constant: false,
            selective: true,
            selectiveLogic: 3,
            order: 35,
            position: 4,
            depth: 2,
            role: 2,
            probability: 65,
            useProbability: true,
            scanDepth: 8,
            caseSensitive: true,
            matchWholeWords: true,
            sourceUid: 12,
        });
    });

    it('accepts a plain entry array and does not turn a missing UID into zero', () => {
        const imported = parseStandardWorldbook(JSON.stringify([
            { comment: '无 UID 条目', content: '内容', key: ['测试'], keysecondary: ['辅助'] },
        ]), '数组导入', 987);

        expect(imported).toHaveLength(1);
        expect(imported[0]).toMatchObject({
            title: '无 UID 条目',
            sourceUid: 0,
            selective: true,
            constant: false,
        });
    });

    it('uses safe defaults when Tavern exports nullable numeric fields', () => {
        const imported = parseStandardWorldbook(JSON.stringify({
            entries: {
                0: { uid: 3, comment: '默认设置', content: '正文', position: null, depth: null, probability: null },
            },
        }), '默认值测试', 55);

        expect(imported[0]).toMatchObject({
            position: 1,
            depth: 4,
            probability: 100,
            order: 100,
            constant: false,
        });
    });

    it('exports a whole group as a standard worldbook that can be imported again', () => {
        const source = [{
            ...book({
                id: 'export-1',
                title: '导出条目',
                content: '导出内容',
                constant: false,
                key: ['导出'],
                position: 4,
                depth: 3,
                role: 2,
            }),
            category: '导出组',
            createdAt: 1,
            updatedAt: 1,
        }];

        const json = serializeStandardWorldbook(source);
        const raw = JSON.parse(json);
        expect(raw.entries['0']).toMatchObject({
            comment: '导出条目',
            key: ['导出'],
            position: 4,
            depth: 3,
            role: 2,
        });

        const imported = parseStandardWorldbook(json, '重新导入', 2);
        expect(imported[0]).toMatchObject({
            title: '导出条目',
            content: '导出内容',
            key: ['导出'],
            position: 4,
            depth: 3,
            role: 2,
        });
    });
});

describe('mounted worldbook synchronization', () => {
    it('copies edited activation and injection settings into the character mount cache', () => {
        const mounted = toMountedWorldbook({
            ...book({
                constant: false,
                key: ['月亮'],
                keysecondary: ['夜晚'],
                selective: true,
                selectiveLogic: 0,
                position: 4,
                depth: 2,
                role: 1,
                disable: true,
                order: 180,
                scanDepth: 6,
                useProbability: true,
                probability: 75,
            }),
            category: '同步测试',
            createdAt: 1,
            updatedAt: 2,
        });

        expect(mounted).toMatchObject({
            constant: false,
            key: ['月亮'],
            keysecondary: ['夜晚'],
            selective: true,
            position: 4,
            depth: 2,
            role: 1,
            disable: true,
            order: 180,
            scanDepth: 6,
            useProbability: true,
            probability: 75,
        });
        expect(mounted).not.toHaveProperty('createdAt');
        expect(mounted).not.toHaveProperty('updatedAt');
    });

    it('mounts a complete generated group without duplicates and keeps it injectable', () => {
        const now = Date.now();
        const generated: Worldbook[] = [
            { ...book({ id: 'generated-1', title: '常驻校规', content: '午夜后禁止离开宿舍。', constant: true, order: 10, position: 1 }), category: '学院', createdAt: now, updatedAt: now },
            { ...book({ id: 'generated-2', title: '雨夜钟楼', content: '钟楼会在雨夜开放。', constant: false, key: ['钟楼'], scanDepth: 4, order: 20, position: 1 }), category: '学院', createdAt: now, updatedAt: now },
        ];
        const mounted = upsertMountedWorldbooks([book({ id: 'existing', title: '已有条目', order: 300 })], generated);
        const retried = upsertMountedWorldbooks(mounted, generated);

        expect(retried.map(entry => entry.id)).toEqual(['existing', 'generated-1', 'generated-2']);
        expect(retried.filter(entry => entry.category === '学院')).toHaveLength(2);
        expect(resolveWorldbookEntries(retried, [{ content: '我们去钟楼看看' }]).map(entry => entry.book.id)).toEqual(['generated-1', 'generated-2', 'existing']);
    });

    it('accepts named Tavern insertion positions as well as numeric positions', () => {
        const names = [
            ['before_char', 0], ['after_char', 1], ['top_of_an', 2],
            ['bottom_of_an', 3], ['at_depth', 4], ['before_example', 5], ['after_example', 6],
        ] as const;
        for (const [position, expected] of names) {
            const imported = parseStandardWorldbook(JSON.stringify({
                entries: [{ comment: position, content: '位置测试', position }],
            }), '位置兼容', 100);
            expect(imported[0].position).toBe(expected);
        }
    });

    it('imports Tavern character card V2/V3 character_book entries with keys aliases', () => {
        const imported = parseStandardWorldbook(JSON.stringify({
            spec: 'chara_card_v2',
            data: {
                name: '测试角色',
                character_book: {
                    name: '角色内置世界书',
                    entries: [{
                        id: 42,
                        keys: ['月港', '潮汐'],
                        secondary_keys: ['午夜'],
                        comment: '月港规则',
                        content: '午夜潮汐上涨时，月港的灯塔会亮起。',
                        enabled: true,
                        selective: true,
                        insertion_order: 25,
                        position: 1,
                        constant: false,
                    }],
                },
            },
        }), '酒馆角色卡导入', 999);

        expect(imported).toHaveLength(1);
        expect(imported[0]).toMatchObject({
            title: '月港规则',
            content: '午夜潮汐上涨时，月港的灯塔会亮起。',
            key: ['月港', '潮汐'],
            keysecondary: ['午夜'],
            selective: true,
            order: 25,
            position: 1,
            disable: false,
            constant: false,
            sourceUid: 42,
        });
    });


    it('explains that a Tavern prompt preset must be imported separately', () => {
        expect(() => parseStandardWorldbook(JSON.stringify({
            prompts: [{ identifier: 'main', content: 'system prompt' }],
            prompt_order: [],
        }), '测试')).toThrow(/提示词预设/);
    });

});
