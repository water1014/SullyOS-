export type LlmApiType = 'openai' | 'anthropic';

export function isAnthropicEndpoint(value: string): boolean {
    try { return /\/messages(?:\/(?:chat\/completions|models))?\/?$/.test(new URL(value).pathname); }
    catch { return false; }
}

const isZenGoPath = (path: string) => path.includes('/zen/go');
const isInferenceGoPath = (path: string) => path.includes('/inference/go');

export function normalizeLlmBaseUrl(value: string, type?: LlmApiType): string {
    const base = value.trim().replace(/\/+$/, '');
    if (!base) return base;
    if (!type) return base;
    try {
        const url = new URL(base);
        let path = url.pathname.replace(/\/+$/, '');
        if (isZenGoPath(path)) {
            // /zen/go is the legacy route. Migrate it to the current documented
            // Go API family so old saved settings keep working after upgrade.
            path = path.replace(/\/(?:chat\/completions|messages(?:\/chat\/completions|\/models)?|models|responses|completions)$/i, '');
            path = path.replace(/\/v1$/i, '');
            path = type === 'anthropic'
                ? '/inference/go/anthropic/v1/messages'
                : '/inference/go/openai/v1';
        } else if (isInferenceGoPath(path)) {
            path = path.replace(/\/(?:openai|anthropic)(?:\/v1)?(?:\/messages(?:\/chat\/completions|\/models)?|\/chat\/completions|\/models)?$/i, '');
            path = path.replace(/\/v1$/i, '');
            path += type === 'anthropic' ? '/anthropic/v1/messages' : '/openai/v1';
        } else if (type === 'anthropic') {
            path = path.replace(/\/(?:messages(?:\/(?:chat\/completions|models))?|chat\/completions|models)\/?$/, '').replace(/\/+$/, '');
            if (!path || path === '/') path = '/v1';
            path += '/messages';
        } else {
            path = path.replace(/\/messages(?:\/(?:chat\/completions|models))?\/?$/, '').replace(/\/chat\/completions\/?$/i, '').replace(/\/models\/?$/i, '');
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

/** Turn opaque browser transport failures into actionable setup guidance. */
export function describeLlmConnectionError(error: unknown, nativeApp = false): string {
    const message = error instanceof Error ? error.message : String(error ?? '');
    if (/AbortError|aborted|timeout/i.test(message)) return '请求超时或已取消，请稍后重试，并检查网络状态。';
    if (/Failed to fetch|NetworkError|Load failed|ERR_NETWORK/i.test(message)) {
        return nativeApp
            ? '网络请求未完成。请检查网络/代理、API 地址和服务商状态；若仍失败，请查看 API 调用记录中的 HTTP 状态或原始错误。'
            : '浏览器无法读取接口响应，可能是 CORS 跨域限制或网络拦截。OpenCode Go 建议在已安装的 Android APK 内测试，APK 会使用原生网络通道。';
    }
    return message || '未知连接错误';
}
