export type LlmApiType = 'openai' | 'anthropic';

export function isAnthropicEndpoint(value: string): boolean {
    try { return /\/messages(?:\/(?:chat\/completions|models))?\/?$/.test(new URL(value).pathname); }
    catch { return false; }
}

const isZenGoPath = (path: string) => path.includes('/zen/go');
const isInferenceGoPath = (path: string) => path.includes('/inference/go');

export function normalizeLlmBaseUrl(value: string, type?: LlmApiType): string {
    const base = value.trim().replace(/\/+$/, '');
    if (!base || !type) return base;
    try {
        const url = new URL(base);
        let path = url.pathname.replace(/\/+$/, '');
        if (isZenGoPath(path)) {
            path = path.replace(/\/v1$/, '');
            path += '/v1';
            if (type === 'anthropic') path += '/messages';
        } else if (isInferenceGoPath(path)) {
            path = path.replace(/\/(?:openai|anthropic)(?:\/v1)?(?:\/messages)?$/, '');
            path = path.replace(/\/v1$/, '');
            path += type === 'anthropic' ? '/anthropic/v1/messages' : '/openai/v1';
        } else if (type === 'anthropic') {
            path = path.replace(/\/(?:messages(?:\/(?:chat\/completions|models))?|chat\/completions|models)\/?$/, '').replace(/\/+$/, '');
            if (!path || path === '/') path = '/v1';
            path += '/messages';
        } else {
            path = path.replace(/\/messages(?:\/(?:chat\/completions|models))?\/?$/, '');
        }
        url.pathname = path || '/';
        return url.href.replace(/\/$/, '');
    } catch { return base; }
}

export function nativeRequestUrl(value: string): string {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/messages\/chat\/completions\/?$/, '/messages').replace(/\/messages\/models\/?$/, '/models');
    return url.href;
}

export const llmApiType = (api: {apiType?: LlmApiType; baseUrl: string}): LlmApiType =>
    api.apiType ?? (isAnthropicEndpoint(api.baseUrl) ? 'anthropic' : 'openai');
