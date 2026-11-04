import type { APIConfig, ApiPreset } from '../types';
import { normalizeLlmBaseUrl } from './llmEndpoint';

// Clipboard contents can carry zero-width characters that String.trim() does not
// remove. They are never valid at the edges of an API URL, token, or model id.
const EDGE_INVISIBLE_CHARS = /^[\s\u200B-\u200D\u2060\uFEFF]+|[\s\u200B-\u200D\u2060\uFEFF]+$/g;

const cleanEdgeCharacters = (value: unknown): string =>
  String(value ?? '').replace(EDGE_INVISIBLE_CHARS, '');

export const normalizeApiBaseUrl = (value: unknown): string =>
  cleanEdgeCharacters(value).replace(/\/+$/, '');

export const normalizeApiCredential = (value: unknown): string =>
  cleanEdgeCharacters(value);

export const normalizeApiModel = (value: unknown): string =>
  cleanEdgeCharacters(value);

/** Keep only valid, browser-sendable custom header names and string values. */
export const normalizeApiHeaders = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const name = cleanEdgeCharacters(rawName).trim();
    const headerValue = String(rawValue ?? '').trim();
    if (!name || !headerValue || /[\r\n\0]/.test(headerValue) || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) continue;
    const lower = name.toLowerCase();
    if (lower === 'host' || lower === 'content-length' || lower === 'origin' || lower === 'referer' || lower === 'cookie' || lower.startsWith('sec-') || lower.startsWith('proxy-')) continue;
    result[name] = headerValue;
  }
  return result;
};

export const isOpenCodeInferenceEndpoint = (baseUrl: string): boolean =>
  /opencode\.ai\/inference\//i.test(baseUrl.trim());

export const buildApiRequestHeaders = (
  apiKey: string,
  customHeaders?: unknown,
  options?: { baseUrl?: string; sessionId?: string },
): Headers => {
  const headers = new Headers({ 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey || 'sk-none'}` });
  // OpenCode Go asks clients to identify each conversation with a stable session ID.
  if (options?.sessionId && options.baseUrl && isOpenCodeGoEndpoint(options.baseUrl)) {
    headers.set('x-opencode-session', options.sessionId);
  }
  for (const [name, value] of Object.entries(normalizeApiHeaders(customHeaders))) headers.set(name, value);
  return headers;
};

export function normalizeApiConfig(config: APIConfig): APIConfig {
  const visionApi = config.visionApi;
  return {
    ...config,
    baseUrl: normalizeLlmBaseUrl(normalizeApiBaseUrl(config.baseUrl), config.apiType),
    apiKey: normalizeApiCredential(config.apiKey),
    model: normalizeApiModel(config.model),
    customHeaders: normalizeApiHeaders(config.customHeaders),
    ...(visionApi ? {
      visionApi: {
        enabled: visionApi.enabled === true,
        baseUrl: normalizeApiBaseUrl(visionApi.baseUrl),
        apiKey: normalizeApiCredential(visionApi.apiKey),
        model: normalizeApiModel(visionApi.model),
      },
    } : {}),
  };
}

export function normalizeApiPreset(preset: ApiPreset): ApiPreset {
  return {
    ...preset,
    name: String(preset.name ?? '').trim(),
    config: normalizeApiConfig(preset.config),
  };
}
