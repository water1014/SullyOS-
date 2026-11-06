import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./anthropicApi', () => ({
    fetchLlm: (resource: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(resource, init),
}));

import { safeFetchJson } from './safeApi';

describe('OpenCode Go explicit overload retry', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it.each([
        ['overloaded', '[overloaded] the server is overloaded; retry shortly'],
        ['prefill capacity', '[prefill_cap_refused] the cell is at capacity; retry shortly (after 5 s)'],
    ])('retries one definitive 429 rejection: %s', async (_label, message) => {
        vi.useFakeTimers();
        const fetchMock = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message } }), {
                status: 429,
                headers: { 'content-type': 'application/json' },
            }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                choices: [{ message: { role: 'assistant', content: 'ok' } }],
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }));

        const pending = safeFetchJson(
            'https://api.test/v1/chat/completions',
            {
                method: 'POST',
                headers: { authorization: 'Bearer test-only', 'x-opencode-session': 'test-session' },
                body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'ping' }] }),
            },
            2,
            0,
            { appName: 'test', purpose: 'retry-test' },
            undefined,
            true,
        );

        await vi.runAllTimersAsync();
        await expect(pending).resolves.toMatchObject({
            choices: [{ message: { content: 'ok' } }],
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not retry an unrelated 429 response', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
            JSON.stringify({ error: { message: 'quota exceeded' } }),
            { status: 429, headers: { 'content-type': 'application/json' } },
        ));

        await expect(safeFetchJson(
            'https://api.test/v1/chat/completions',
            { method: 'POST', body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [] }) },
            2,
            0,
            undefined,
            undefined,
            true,
        )).rejects.toThrow('API Error 429');

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not retry a chat completion after an ambiguous network failure', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));

        await expect(safeFetchJson(
            'https://api.test/v1/chat/completions',
            { method: 'POST', body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [] }) },
            2,
            0,
            undefined,
            undefined,
            true,
        )).rejects.toThrow('Failed to fetch');

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
