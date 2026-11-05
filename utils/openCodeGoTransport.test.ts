import { describe, expect, it, vi } from 'vitest';
import { createOpenCodeGoTransport } from './openCodeGoTransport';

describe('OpenCode Go transport', () => {
  it('routes zen/go requests through the native HTTP bridge', async () => {
    const native = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{"choices":[{"message":{"content":"ok"}}]}', {
      status: 200,
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
    const [calledUrl, calledInit] = native.mock.calls[0];
    expect(calledUrl).toBe('https://opencode.ai/zen/go/v1/chat/completions');
    expect(calledInit?.method).toBe('POST');
    expect(new Headers(calledInit?.headers).get('authorization')).toBe('Bearer go-token');
    expect(new Headers(calledInit?.headers).get('x-opencode-session')).toBe('chat-1');
    expect(new Headers(calledInit?.headers).get('user-agent')).toBe('SullyOS/1.0');
    expect(fallback).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: 'ok' } }] });
  });

  it('routes the canonical inference/go endpoint through native HTTP too', async () => {
    const native = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{"data":[]}', { status: 200 }));
    const fallback = vi.fn(async () => new Response('fallback'));
    const transport = createOpenCodeGoTransport(true, native, fallback);
    await transport('https://opencode.ai/inference/go/v1/models');
    expect(native).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
  });

  it('preserves a streaming response body from the native fetch implementation', async () => {
    const native = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: first\\n\\n'));
        controller.enqueue(new TextEncoder().encode('data: second\\n\\n'));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const fallback = vi.fn(async () => new Response('fallback'));
    const transport = createOpenCodeGoTransport(true, native, fallback);
    const response = await transport('https://opencode.ai/zen/go/v1/chat/completions');
    const reader = response.body!.getReader();
    const first = await reader.read();
    const second = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('data: first');
    expect(new TextDecoder().decode(second.value)).toContain('data: second');
    expect(first.done).toBe(false);
    expect(second.done).toBe(false);
  });

  it('keeps browser and unrelated requests on fetch', async () => {
    const native = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('native'));
    const fallback = vi.fn(async () => Response.json({ ok: true }));
    const transport = createOpenCodeGoTransport(false, native, fallback);
    const response = await transport('https://opencode.ai/zen/go/v1/models');
    expect(native).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({ ok: true });
  });
});
