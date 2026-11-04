import { describe, expect, it, vi } from 'vitest';
import { createOpenCodeGoTransport } from './openCodeGoTransport';

describe('OpenCode Go transport', () => {
  it('routes zen/go requests through the native HTTP bridge', async () => {
    const native = vi.fn(async () => ({
      status: 200,
      data: '{"choices":[{"message":{"content":"ok"}}]}',
      headers: { 'content-type': 'application/json' },
    }));
    const fallback = vi.fn(async () => new Response('browser fallback'));
    const transport = createOpenCodeGoTransport(true, native, fallback);
    const response = await transport('https://opencode.ai/zen/go/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer go-token', 'x-opencode-session': 'chat-1' },
      body: JSON.stringify({ model: 'kimi-k3', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(native).toHaveBeenCalledOnce();
    expect(native).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://opencode.ai/zen/go/v1/chat/completions',
      method: 'POST',
      headers: expect.objectContaining({ authorization: 'Bearer go-token', 'x-opencode-session': 'chat-1' }),
      responseType: 'text',
    }));
    expect(fallback).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: 'ok' } }] });
  });

  it('routes the canonical inference/go endpoint through native HTTP too', async () => {
    const native = vi.fn(async () => ({ status: 200, data: '{"data":[]}' }));
    const fallback = vi.fn(async () => new Response('fallback'));
    const transport = createOpenCodeGoTransport(true, native, fallback);
    await transport('https://opencode.ai/inference/go/v1/models');
    expect(native).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
  });

  it('keeps browser and unrelated requests on fetch', async () => {
    const native = vi.fn();
    const fallback = vi.fn(async () => Response.json({ ok: true }));
    const transport = createOpenCodeGoTransport(false, native, fallback);
    const response = await transport('https://opencode.ai/zen/go/v1/models');
    expect(native).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({ ok: true });
  });
});
