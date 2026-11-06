import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./anthropicApi', () => ({
  fetchLlm: (url: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(url, init),
}));

import { safeFetchJson } from './safeApi';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OpenCode Go overload retry policy', () => {
  it('retries exactly once for an explicit 429 overloaded rejection when opted in', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { type: 'server_error', message: 'Upstream request failed: [overloaded] the server is overloaded; retry shortly' },
      }), { status: 429, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = safeFetchJson('https://opencode.ai/inference/go/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-opencode-session': 'ses_test' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] }),
    }, 2, 0, { appName: '彼方', purpose: '自由活动' }, undefined, true);

    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.choices[0].message.content).toBe('ok');
  });

  it('does not retry a generic 429 that is not an overload rejection', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'Rate limit exceeded' },
    }), { status: 429, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(safeFetchJson('https://opencode.ai/inference/go/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-opencode-session': 'ses_test' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] }),
    }, 2, 0, { appName: '彼方', purpose: '自由活动' }, undefined, true)).rejects.toThrow('API Error 429');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
