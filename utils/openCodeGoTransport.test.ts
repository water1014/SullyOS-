import { describe, expect, it, vi } from 'vitest';
import { createOpenCodeGoTransport, normalizeOpenCodeGoRequestUrl } from './openCodeGoTransport';

describe('OpenCode Go transport', () => {
  it('normalizes raw Go roots for feature-specific API callers', () => {
    expect(normalizeOpenCodeGoRequestUrl('https://opencode.ai/zen/go/chat/completions')).toBe('https://opencode.ai/inference/go/openai/v1/chat/completions');
    expect(normalizeOpenCodeGoRequestUrl('https://opencode.ai/zen/go/messages')).toBe('https://opencode.ai/inference/go/anthropic/v1/messages');
    expect(normalizeOpenCodeGoRequestUrl('https://opencode.ai/inference/go/chat/completions')).toBe('https://opencode.ai/inference/go/openai/v1/chat/completions');
    expect(normalizeOpenCodeGoRequestUrl('https://opencode.ai/zen/go/v1/chat/completions')).toBe('https://opencode.ai/inference/go/openai/v1/chat/completions');
    expect(normalizeOpenCodeGoRequestUrl('https://opencode.ai/inference/go/v1/chat/completions')).toBe('https://opencode.ai/inference/go/openai/v1/chat/completions');
    expect(normalizeOpenCodeGoRequestUrl('https://opencode.ai/inference/go/v1/messages')).toBe('https://opencode.ai/inference/go/anthropic/v1/messages');
    expect(normalizeOpenCodeGoRequestUrl('https://opencode.ai/inference/go/v1/models')).toBe('https://opencode.ai/inference/go/v1/models');
  });

  it('adds a stable session header to Go requests that forgot to provide one', async () => {
    const native = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => Response.json({
      session: new Headers(init?.headers).get('x-opencode-session'),
    }));
    const fallback = vi.fn(async () => new Response('fallback'));
    const transport = createOpenCodeGoTransport(true, native, fallback);

    const first = await transport('https://opencode.ai/zen/go/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] }),
      __sullyMeta: { charId: 'character-1' } as any,
    } as RequestInit);
    const second = await transport('https://opencode.ai/zen/go/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'again' }] }),
      __sullyMeta: { charId: 'character-1' } as any,
    } as RequestInit);
    const other = await transport('https://opencode.ai/zen/go/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'other' }] }),
      __sullyMeta: { charId: 'character-2' } as any,
    } as RequestInit);

    const firstSession = (await first.json()).session;
    expect(firstSession).toBeTruthy();
    expect((await second.json()).session).toBe(firstSession);
    expect((await other.json()).session).not.toBe(firstSession);
  });

  it('preserves an explicitly supplied OpenCode Go session header', async () => {
    const native = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => Response.json({
      session: new Headers(init?.headers).get('x-opencode-session'),
    }));
    const transport = createOpenCodeGoTransport(true, native, vi.fn(async () => new Response('fallback')));
    const response = await transport('https://opencode.ai/zen/go/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-opencode-session': 'explicit-session' },
      body: '{}',
    });
    expect((await response.json()).session).toBe('explicit-session');
  });

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
    expect(calledUrl).toBe('https://opencode.ai/inference/go/openai/v1/chat/completions');
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
    const fallback = vi.fn(async (_resource: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true }));
    const transport = createOpenCodeGoTransport(false, native, fallback);
    const response = await transport('https://opencode.ai/zen/go/v1/models');
    expect(native).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();
    const [, request] = fallback.mock.calls[0];
    expect(new Headers(request?.headers).get('x-opencode-session')).toBeTruthy();
    expect(await response.json()).toEqual({ ok: true });
  });
});
