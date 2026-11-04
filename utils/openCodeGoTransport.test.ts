import { describe, expect, it, vi } from 'vitest';
import { createOpenCodeGoTransport } from './openCodeGoTransport';

describe('OpenCode Go native transport', () => {
  it('uses native HTTP for Go inference calls in a Capacitor app and preserves auth/session headers', async () => {
    const native = vi.fn(async () => ({
      status: 200,
      data: '{"choices":[{"message":{"content":"你好"}}]}',
      headers: { 'content-type': 'application/json' },
    }));
    const fallback = vi.fn(async () => new Response('browser fallback'));
    const transport = createOpenCodeGoTransport(true, native, fallback);
    const response = await transport('https://opencode.ai/inference/go/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret',
        'x-opencode-session': 'ses_test',
        'X-Extra': 'kept',
      },
      body: JSON.stringify({ model: 'kimi-k3', messages: [{ role: 'user', content: '你好' }] }),
    });

    expect(native).toHaveBeenCalledOnce();
    expect(native).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://opencode.ai/inference/go/openai/v1/chat/completions',
      method: 'POST',
      headers: expect.objectContaining({
        authorization: 'Bearer secret',
        'x-opencode-session': 'ses_test',
        'x-extra': 'kept',
      }),
      data: JSON.stringify({ model: 'kimi-k3', messages: [{ role: 'user', content: '你好' }] }),
      responseType: 'text',
    }));
    expect(fallback).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: '你好' } }] });
  });

  it('keeps normal browser requests on fetch', async () => {
    const native = vi.fn();
    const fallback = vi.fn(async () => Response.json({ ok: true }));
    const transport = createOpenCodeGoTransport(false, native, fallback);
    const response = await transport('https://opencode.ai/inference/go/v1/models', { method: 'GET' });
    expect(native).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({ ok: true });
  });

  it('does not route unrelated hosts through native HTTP', async () => {
    const native = vi.fn();
    const fallback = vi.fn(async () => new Response('ok'));
    const transport = createOpenCodeGoTransport(true, native, fallback);
    await transport('https://api.example.com/v1/chat/completions');
    expect(native).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();
  });
});
