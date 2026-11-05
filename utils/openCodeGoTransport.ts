type NativeStreamingFetch = typeof fetch;

// Resolve fetch at call time so tests, webviews, and host fetch instrumentation can replace it.
const fallbackFetch: typeof fetch = (resource, init) => globalThis.fetch(resource, init);
let activeTransport: typeof fetch = fallbackFetch;

/**
 * OpenCode Go does not expose browser CORS access consistently. The native app
 * injects a streaming native bridge from index.tsx; worker bundles keep this module
 * dependency-free and continue using ordinary fetch.
 */
export function configureOpenCodeGoNativeTransport(
  isNative: boolean,
  nativeFetch?: NativeStreamingFetch,
): void {
  activeTransport = isNative && nativeFetch
    ? createOpenCodeGoTransport(true, nativeFetch, fallbackFetch)
    : fallbackFetch;
}

/**
 * Route only OpenCode Go inference calls through the injected native HTTP stack.
 * Ordinary browser/PWA requests and unrelated app networking remain on fetch.
 */
export function createOpenCodeGoTransport(
  isNative: boolean,
  nativeFetch: NativeStreamingFetch,
  fallback: typeof fetch,
): typeof fetch {
  return async (resource: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof resource === 'string'
      ? resource
      : resource instanceof URL ? resource.href : resource.url;
    if (!isNative || !(/opencode\.ai\/(?:inference\/go|zen\/go)(?:\/|$)/i.test(url))) {
      return fallback(resource, init);
    }
    const request = resource instanceof Request ? resource : undefined;
    const method = (init?.method || request?.method || 'GET').toUpperCase();
    const headers = new Headers(init?.headers || request?.headers);
    if (!headers.has('user-agent')) headers.set('user-agent', 'SullyOS/1.0');
    const body = init?.body ?? (request && method !== 'GET' && method !== 'HEAD'
      ? await request.clone().text()
      : undefined);
    if (body != null && typeof body !== 'string') return fallback(resource, init);
    if (init?.signal?.aborted || request?.signal.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    return nativeFetch(url, {
      method,
      headers,
      ...(body != null ? { body } : {}),
      signal: init?.signal || request?.signal,
    });
  };
}

export const fetchOpenCodeGo: typeof fetch = (resource, init) => activeTransport(resource, init);
