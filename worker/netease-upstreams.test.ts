import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const workerSource = readFileSync(
  fileURLToPath(new URL('./index.js', import.meta.url)),
  'utf8',
);

function loadUpstreamHelpers(fetchMock: typeof fetch) {
  const start = workerSource.indexOf('function shuffleCopy(arr)');
  const end = workerSource.indexOf('\n\n// ================================================================', start);
  if (start < 0 || end < 0) throw new Error('Could not locate Netease upstream helper block.');

  const sandbox: Record<string, unknown> = {
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: fetchMock,
    Math: Object.assign(Object.create(Math), { random: () => 0.999999 }),
  };
  runInNewContext(
    workerSource.slice(start, end)
      + '\nglobalThis.__helpers = { resolveNeteaseUpstreams, fetchFromAnyUpstream };',
    sandbox,
  );
  return sandbox.__helpers as {
    resolveNeteaseUpstreams: (env: { NETEASE_UPSTREAMS?: string }) => string[];
    fetchFromAnyUpstream: (path: string, env: { NETEASE_UPSTREAMS?: string }) => Promise<{
      text: string; status: number; upstream: string; error: string | null; tried: number;
    }>;
  };
}

describe('Netease upstream failover', () => {
  it('treats a lone risk-controlled upstream as failure instead of success', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: -460, message: 'risk control' }),
    } as Response);
    const helpers = loadUpstreamHelpers(fetchMock);
    const result = await helpers.fetchFromAnyUpstream('/search', {
      NETEASE_UPSTREAMS: 'https://music-one.example',
    });

    expect(result.status).toBe(502);
    expect(result.error).toContain('risk-control (code=-460/-7)');
    expect(result.tried).toBe(1);
    expect(result.upstream).toBe('');
  });

  it('moves to the next upstream after a risk-control response', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: -7, message: 'blocked' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 200, result: [] }),
      } as Response);
    const helpers = loadUpstreamHelpers(fetchMock);
    const result = await helpers.fetchFromAnyUpstream('/search', {
      NETEASE_UPSTREAMS: 'https://music-one.example https://music-two.example',
    });

    expect(result.status).toBe(200);
    expect(result.upstream).toBe('music-two.example');
    expect(result.tried).toBe(2);
    expect(result.error).toBeNull();
  });
});
