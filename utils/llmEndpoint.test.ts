import { describe, expect, it } from 'vitest';
import { normalizeLlmBaseUrl, nativeRequestUrl, describeLlmConnectionError } from './llmEndpoint';

describe('OpenCode Go URL normalization', () => {
  it('normalizes the zen/go root for OpenAI-compatible chat', () => {
    expect(normalizeLlmBaseUrl('https://opencode.ai/zen/go', 'openai'))
      .toBe('https://opencode.ai/inference/go/openai/v1');
  });

  it('normalizes the zen/go root for Anthropic Messages', () => {
    expect(normalizeLlmBaseUrl('https://opencode.ai/zen/go', 'anthropic'))
      .toBe('https://opencode.ai/inference/go/anthropic/v1/messages');
  });

  it('maps the canonical inference/go root to protocol-specific bases', () => {
    expect(normalizeLlmBaseUrl('https://opencode.ai/inference/go', 'openai'))
      .toBe('https://opencode.ai/inference/go/openai/v1');
    expect(normalizeLlmBaseUrl('https://opencode.ai/inference/go', 'anthropic'))
      .toBe('https://opencode.ai/inference/go/anthropic/v1/messages');
  });

  it('normalizes an Anthropic chat-completions suffix back to Messages', () => {
    expect(nativeRequestUrl('https://opencode.ai/zen/go/v1/messages/chat/completions'))
      .toBe('https://opencode.ai/inference/go/anthropic/v1/messages');
  });

  it('normalizes pasted OpenCode Go full endpoint URLs without duplicating path segments', () => {
    expect(normalizeLlmBaseUrl('https://opencode.ai/zen/go/v1/chat/completions', 'openai'))
      .toBe('https://opencode.ai/inference/go/openai/v1');
    expect(normalizeLlmBaseUrl('https://opencode.ai/zen/go/v1/models', 'openai'))
      .toBe('https://opencode.ai/inference/go/openai/v1');
    expect(normalizeLlmBaseUrl('https://opencode.ai/zen/go/v1/messages', 'anthropic'))
      .toBe('https://opencode.ai/inference/go/anthropic/v1/messages');
    expect(normalizeLlmBaseUrl('https://opencode.ai/inference/go/openai/v1/chat/completions', 'openai'))
      .toBe('https://opencode.ai/inference/go/openai/v1');
    expect(normalizeLlmBaseUrl('https://opencode.ai/inference/go/anthropic/v1/messages', 'anthropic'))
      .toBe('https://opencode.ai/inference/go/anthropic/v1/messages');
  });


  it('normalizes pasted OpenCode Go endpoint suffixes without duplicating routes', () => {
    expect(normalizeLlmBaseUrl('https://opencode.ai/zen/go/v1/chat/completions', 'openai'))
      .toBe('https://opencode.ai/inference/go/openai/v1');
    expect(normalizeLlmBaseUrl('https://opencode.ai/zen/go/v1/messages/chat/completions', 'anthropic'))
      .toBe('https://opencode.ai/inference/go/anthropic/v1/messages');
    expect(normalizeLlmBaseUrl('https://opencode.ai/inference/go/openai/v1/chat/completions', 'openai'))
      .toBe('https://opencode.ai/inference/go/openai/v1');
  });


  it('explains opaque fetch failures differently for browser and native APK', () => {
    const error = new TypeError('Failed to fetch');
    expect(describeLlmConnectionError(error, false)).toContain('CORS');
    expect(describeLlmConnectionError(error, false)).toContain('Android APK');
    expect(describeLlmConnectionError(error, true)).toContain('网络请求未完成');
    expect(describeLlmConnectionError(new Error('timeout 60000ms'), true)).toContain('超时');
  });

});
