import { getOpenCodeSessionId, isOpenCodeGoEndpoint } from './apiConfigNormalize';
type NativeStreamingFetch = typeof fetch;
// Capture the runtime fetch before installAnthropicFetch wraps globalThis.fetch.
// A dynamic lookup here would recurse: the wrapper delegates back to this transport.
const fallbackFetch: typeof fetch = globalThis.fetch.bind(globalThis);
let activeTransport: typeof fetch = createOpenCodeGoTransport(false, fallbackFetch, fallbackFetch);

/** Normalize raw Go service roots used by older feature-specific settings. */
export function normalizeOpenCodeGoRequestUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { return value; }
  const path = parsed.pathname.replace(/\/+$/, '');
  const lower = path.toLowerCase();
  if (lower.startsWith('/zen/go/')) {
    const tail = path.slice('/zen/go/'.length).replace(/^v1\//i, '');
    if (/^messages(?:\/|$)/i.test(tail)) parsed.pathname = '/inference/go/anthropic/v1/' + tail;
    else if (/^(?:chat\/completions|responses|completions|models)(?:\/|$)/i.test(tail)) parsed.pathname = '/inference/go/openai/v1/' + tail;
  } else if (lower.startsWith('/inference/go/')) {
    const tail = path.slice('/inference/go/'.length);
    if (/^v1\//i.test(tail)) {
      const endpoint = tail.replace(/^v1\//i, '');
      if (/^messages(?:\/|$)/i.test(endpoint)) parsed.pathname = '/inference/go/anthropic/v1/' + endpoint;
      else if (/^(?:chat\/completions|responses|completions|models)(?:\/|$)/i.test(endpoint)) parsed.pathname = '/inference/go/openai/v1/' + endpoint;
    } else if (!/^(?:openai|anthropic|google)\//i.test(tail)) {
      if (/^(?:chat\/completions|responses|completions|models)(?:\/|$)/i.test(tail)) parsed.pathname = '/inference/go/openai/v1/' + tail;
      else if (/^messages(?:\/|$)/i.test(tail)) parsed.pathname = '/inference/go/anthropic/v1/' + tail;
    }
  }
  return parsed.href;
}
export function configureOpenCodeGoNativeTransport(isNative: boolean, nativeFetch?: NativeStreamingFetch): void {
  activeTransport = createOpenCodeGoTransport(isNative, nativeFetch || fallbackFetch, fallbackFetch);
}
export function createOpenCodeGoTransport(isNative: boolean, nativeFetch: NativeStreamingFetch, fallback: typeof fetch): typeof fetch {
  return async (resource: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = resource instanceof Request ? resource : undefined;
    const rawUrl = typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url;
    if (!isOpenCodeGoEndpoint(rawUrl)) return fallback(resource, init);
    const url = normalizeOpenCodeGoRequestUrl(rawUrl);
    const method = (init?.method || request?.method || 'GET').toUpperCase();
    const headers = new Headers(init?.headers || request?.headers);
    const requestMeta = (init as (RequestInit & { __sullyMeta?: { charId?: string } }) | undefined)?.__sullyMeta;
    if (!headers.has('x-opencode-session')) {
      const scope = requestMeta?.charId ? 'conversation:' + requestMeta.charId : 'app-default';
      headers.set('x-opencode-session', getOpenCodeSessionId('transport:' + scope));
    }
    if (!isNative) {
      const fallbackResource = request ? new Request(url, request) : url;
      return fallback(fallbackResource, { ...(init || {}), headers });
    }
    if (!headers.has('user-agent')) headers.set('user-agent', 'SullyOS/1.0');
    const body = init?.body ?? (request && method !== 'GET' && method !== 'HEAD' ? await request.clone().text() : undefined);
    if (body != null && typeof body !== 'string') {
      const fallbackResource = request ? new Request(url, request) : url;
      return fallback(fallbackResource, { ...(init || {}), headers });
    }
    if (init?.signal?.aborted || request?.signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    return nativeFetch(url, { method, headers, ...(body != null ? { body } : {}), signal: init?.signal || request?.signal });
  };
}
export const fetchOpenCodeGo: typeof fetch = (resource, init) => activeTransport(resource, init);
