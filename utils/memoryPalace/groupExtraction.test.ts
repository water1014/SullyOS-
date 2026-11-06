import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../types';
import { safeFetchJson } from '../safeApi';
import { extractGroupMemoriesFromBuffer } from './groupExtraction';

vi.mock('../safeApi', () => ({ safeFetchJson: vi.fn() }));
const mockedSafeFetchJson = vi.mocked(safeFetchJson);

const messages: Message[] = [{
    id: 1,
    charId: 'group-member-a',
    role: 'user',
    type: 'text',
    content: '今天大家一起去了海边。',
    timestamp: new Date('2026-11-06T08:00:00Z').getTime(),
}];

describe('group memory OpenCode Go request contract', () => {
    beforeEach(() => {
        mockedSafeFetchJson.mockReset();
        mockedSafeFetchJson.mockResolvedValue({
            choices: [{ message: { content: '[]' } }],
        } as any);
    });

    it('uses a stable session header and enables only explicit Go overload retry', async () => {
        await extractGroupMemoriesFromBuffer(
            messages,
            '周末小组',
            ['甲', '乙'],
            '用户',
            () => '甲',
            {
                baseUrl: 'https://opencode.ai/inference/go/openai/v1',
                apiKey: 'test-only',
                model: 'deepseek-v4.1-flash',
            },
        );

        expect(mockedSafeFetchJson).toHaveBeenCalledTimes(1);
        const [, init, , , , , retryGoOverload] = mockedSafeFetchJson.mock.calls[0];
        const headers = new Headers((init as RequestInit).headers);
        expect(headers.get('authorization')).toBe('Bearer test-only');
        expect(headers.get('x-opencode-session')).toMatch(/^sullyos-/);
        expect(retryGoOverload).toBe(true);
        const body = JSON.parse(String((init as RequestInit).body));
        expect(body.model).toBe('deepseek-v4.1-flash');
    });

    it('does not enable Go overload retry for a non-Go memory endpoint', async () => {
        await extractGroupMemoriesFromBuffer(
            messages,
            '普通小组',
            ['甲'],
            '用户',
            () => '甲',
            {
                baseUrl: 'https://memory.example/v1',
                apiKey: 'test-only',
                model: 'memory-model',
            },
        );

        const call = mockedSafeFetchJson.mock.calls[0];
        expect(call[6]).toBe(false);
    });
});
