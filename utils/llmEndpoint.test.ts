import { describe, expect, it } from 'vitest';
import { normalizeLlmBaseUrl, nativeRequestUrl } from './llmEndpoint';

describe('OpenCode Go URL normalization', () => {
  it('normalizes the zen/go root for OpenAI-compatible chat', () => {
    expect(normalizeLlmBaseUrl('https://opencode.ai/zen/go', 'openai'))
      .toBe('https://opencode.ai/zen/go/v1');
  });

  it('normalizes the zen/go root for Anthropic Messages', () => {
    expect(normalizeLlmBaseUrl('https://opencode.ai/zen/go', 'anthropic'))
      .toBe('https://opencode.ai/zen/go/v1/messages');
  });

  it('maps the canonical inference/go root to protocol-specific bases', () => {
    expect(normalizeLlmBaseUrl('https://opencode.ai/inference/go', 'openai'))
      .toBe('https://opencode.ai/inference/go/openai/v1');
    expect(normalizeLlmBaseUrl('https://opencode.ai/inference/go', 'anthropic'))
      .toBe('https://opencode.ai/inference/go/anthropic/v1/messages');
  });

  it('normalizes an Anthropic chat-completions suffix back to Messages', () => {
    expect(nativeRequestUrl('https://opencode.ai/zen/go/v1/messages/chat/completions'))
      .toBe('https://opencode.ai/zen/go/v1/messages');
  });
});
