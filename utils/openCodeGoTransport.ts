import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { isOpenCodeGoEndpoint } from './apiConfigNormalize';

type NativeHttpRequest = (options: Record<string, unknown>) => Promise<{
  status: number;
  data: unknown;
  headers?: Record<string, string>;
}>;

/**
 * OpenCode Go does not expose browser CORS access consistently. In the Android/iOS
 * Capacitor app, route only Go inference calls through Capacitor's native HTTP stack.
 * Ordinary browser/PWA requests keep using fetch. This is deliberately not a global
 * fetch patch, so streaming and unrelated app networking are left untouched.
 */
export function createOpenCodeGoTransport(
  isNative: boolean,
  nativeRequest: NativeHttpRequest,
  fallback: typeof fetch,
): typeof fetch {
  return async (resource: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = resource instanceof Request ? resource : undefined;
    const url = typeof resource === 'string'
      ? resource
      : resource instanceof URL ? resource.href : resource.url;

    if (!isNative || !isOpenCodeGoEndpoint(url)) return fallback(resource, init);

    const method = (init?.method || request?.method || 'GET').toUpperCase();
    const headers = new Headers(init?.headers || request?.headers);
    const body = init?.body ?? (request && method !== 'GET' && method !== 'HEAD'
      ? await request.clone().text()
      : undefined);

    // LLM requests are JSON strings. Leave binary/FormData callers on the normal fetch path.
    if (body != null && typeof body !== 'string') return fallback(resource, init);
    if (init?.signal?.aborted || request?.signal.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    const result = await nativeRequest({
      url,
      method,
      headers: Object.fromEntries(headers.entries()),
      ...(body != null ? { data: body } : {}),
      responseType: 'text',
      connectTimeout: 30_000,
      readTimeout: 120_000,
    });

    if (init?.signal?.aborted || request?.signal.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    const responseHeaders = new Headers(result.headers || {});
    const responseBody = typeof result.data === 'string'
      ? result.data
      : result.data == null ? null : JSON.stringify(result.data);
    return new Response(responseBody, {
      status: result.status,
      headers: responseHeaders,
    });
  };
}

export const fetchOpenCodeGo: typeof fetch = createOpenCodeGoTransport(
  Capacitor.isNativePlatform(),
  options => CapacitorHttp.request(options as any),
  globalThis.fetch.bind(globalThis),
);
