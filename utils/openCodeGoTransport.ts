type NativeHttpRequest = (options: Record<string, unknown>) => Promise<{
  status: number;
  data: unknown;
  headers?: Record<string, string>;
}>;

const fallbackFetch: typeof fetch = globalThis.fetch.bind(globalThis);
let activeTransport: typeof fetch = fallbackFetch;

/**
 * OpenCode Go does not expose browser CORS access consistently. The native app
 * injects Capacitor's HTTP bridge from index.tsx; worker bundles keep this module
 * dependency-free and continue using ordinary fetch.
 */
export function configureOpenCodeGoNativeTransport(
  isNative: boolean,
  nativeRequest?: NativeHttpRequest,
): void {
  activeTransport = isNative && nativeRequest
    ? createOpenCodeGoTransport(true, nativeRequest, fallbackFetch)
    : fallbackFetch;
}

/**
 * Route only OpenCode Go inference calls through the injected native HTTP stack.
 * Ordinary browser/PWA requests and unrelated app networking remain on fetch.
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

    if (!isNative || !(/opencode\.ai\/(?:inference\/go|zen\/go)(?:\/|$)/i.test(url))) return fallback(resource, init);

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

export const fetchOpenCodeGo: typeof fetch = (resource, init) => activeTransport(resource, init);
