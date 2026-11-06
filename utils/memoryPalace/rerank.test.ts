import { afterEach, describe, expect, it, vi } from 'vitest';
import { rerankDocuments } from './rerank';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('memory rerank with OpenCode Go', () => {
  it('uses chat completions, stable session headers, and validates returned indices', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            results: [
              { index: 1, relevance_score: 0.96 },
              { index: 0, relevance_score: 0.22 },
              { index: 99, relevance_score: 1 },
            ],
          }),
        },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const results = await rerankDocuments({
      baseUrl: 'https://opencode.ai/zen/go',
      apiKey: 'go-token',
      model: 'deepseek-v4.1-flash',
    }, '用户正在找宋祁的生日', ['一段日常对话', '宋祁的生日是五月十二日'], 2);

    expect(results).toEqual([
      { index: 1, relevance_score: 0.96 },
      { index: 0, relevance_score: 0.22 },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://opencode.ai/zen/go/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer go-token');
    expect(new Headers(init?.headers).get('x-opencode-session')).toMatch(/^ses_/);
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('deepseek-v4.1-flash');
    expect(body.messages[1].content).toContain('宋祁的生日是五月十二日');
  });
});
