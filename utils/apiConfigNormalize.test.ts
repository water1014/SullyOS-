import { describe, expect, it } from 'vitest';
import { normalizeLlmBaseUrl } from './llmEndpoint';
import {
  normalizeApiBaseUrl,
  normalizeApiConfig,
  normalizeApiCredential,
  normalizeApiHeaders,
  buildApiRequestHeaders,
  isOpenCodeInferenceEndpoint,
  isOpenCodeGoEndpoint,
} from './apiConfigNormalize';

describe('API config normalization', () => {
  it('removes pasted whitespace and invisible edge characters from credentials', () => {
    expect(normalizeApiCredential(' \n\u200Bsk-example\u2060\r ')).toBe('sk-example');
  });

  it('normalizes the base URL without touching its path', () => {
    expect(normalizeApiBaseUrl('  https://api.example.com/v1///\u200B ')).toBe('https://api.example.com/v1');
  });

  it('normalizes the user-facing OpenCode Zen Go URL to the OpenAI-compatible v1 root', () => {
    expect(normalizeLlmBaseUrl('https://opencode.ai/zen/go', 'openai')).toBe('https://opencode.ai/zen/go/v1');
    expect(normalizeLlmBaseUrl('https://opencode.ai/zen/go/', 'openai')).toBe('https://opencode.ai/zen/go/v1');
    expect(isOpenCodeGoEndpoint('https://opencode.ai/zen/go/v1')).toBe(true);
  });

  it('recognizes OpenCode inference endpoints for both supported API families', () => {
    expect(isOpenCodeInferenceEndpoint('https://opencode.ai/inference/openai/v1')).toBe(true);
    expect(isOpenCodeInferenceEndpoint('https://opencode.ai/inference/anthropic/v1/messages')).toBe(true);
    expect(isOpenCodeInferenceEndpoint('https://api.example.com/v1')).toBe(false);
  });

  it('normalizes legacy zen/go roots on load for both protocol families', () => {
    expect(normalizeApiConfig({
      baseUrl: 'https://opencode.ai/zen/go',
      apiKey: 'go-token',
      model: 'kimi-k3',
    }).baseUrl).toBe('https://opencode.ai/zen/go/v1');
    expect(normalizeApiConfig({
      baseUrl: 'https://opencode.ai/zen/go',
      apiKey: 'go-token',
      model: 'qwen3.8-max',
      apiType: 'anthropic',
    }).baseUrl).toBe('https://opencode.ai/zen/go/v1/messages');
  });

  it('keeps valid custom headers and drops invalid or browser-forbidden headers', () => {
    expect(normalizeApiHeaders({ ' X-OpenCode-Session ': ' session-1 ', 'bad header': 'x', Cookie: 'secret', 'X-Empty': '  ' }))
      .toEqual({ 'X-OpenCode-Session': 'session-1' });
    const headers = buildApiRequestHeaders('go-token', { 'X-OpenCode-Session': 'session-1' });
    expect(headers.get('authorization')).toBe('Bearer go-token');
    expect(headers.get('x-opencode-session')).toBe('session-1');
    const goHeaders = buildApiRequestHeaders('go-token', {}, { baseUrl: 'https://opencode.ai/inference/go/openai/v1', sessionId: 'character-session-1' });
    expect(goHeaders.get('x-opencode-session')).toBe('character-session-1');
    const paygoHeaders = buildApiRequestHeaders('key', {}, { baseUrl: 'https://opencode.ai/inference/openai/v1', sessionId: 'not-go' });
    expect(paygoHeaders.has('x-opencode-session')).toBe(false);
    const overridden = buildApiRequestHeaders('go-token', { 'X-OpenCode-Session': 'manual-session' }, { baseUrl: 'https://opencode.ai/inference/go/openai/v1', sessionId: 'automatic-session' });
    expect(overridden.get('x-opencode-session')).toBe('manual-session');
  });

  it('keeps unrelated API settings intact', () => {
    expect(normalizeApiConfig({
      baseUrl: ' https://api.example.com/v1/ ',
      apiKey: '\uFEFFsk-test\u200B',
      model: ' gpt-test ',
      stream: true,
      temperature: 0.7,
      minimaxApiKey: 'mini-key',
      visionApi: {
        enabled: true,
        baseUrl: ' https://vision.example.com/v1/// ',
        apiKey: '\u200Bvision-key\u2060',
        model: ' vision-model ',
      },
    })).toEqual({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-test',
      customHeaders: {},
      stream: true,
      temperature: 0.7,
      minimaxApiKey: 'mini-key',
      visionApi: {
        enabled: true,
        baseUrl: 'https://vision.example.com/v1',
        apiKey: 'vision-key',
        model: 'vision-model',
      },
    });
  });
});
