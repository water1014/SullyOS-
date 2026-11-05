import type { APIConfig } from '../types';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { getOpenCodeSessionId, isOpenCodeGoEndpoint, normalizeApiConfig } from './apiConfigNormalize';

const STORAGE_KEY = 'check_phone_api';

/** 查手机 App 独立 API；null 表示跟随聊天默认。 */
export function getCheckPhoneApi(): APIConfig | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = normalizeApiConfig(JSON.parse(raw) as APIConfig);
        return parsed.baseUrl ? parsed : null;
    } catch {
        return null;
    }
}

export function setCheckPhoneApi(config: APIConfig | null): void {
    try {
        if (!config?.baseUrl) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeApiConfig(config)));
        window.dispatchEvent(new CustomEvent('check-phone-api-changed'));
    } catch { /* localStorage may be unavailable in private/restricted contexts */ }
}

export function resolveCheckPhoneApi(independent: APIConfig | null, chatDefault: APIConfig): APIConfig {
    return independent?.baseUrl ? independent : chatDefault;
}



/**
 * OpenAI-compatible request used by the Check Phone app.
 * Android WebView fetch is subject to browser CORS; CapacitorHttp performs the
 * same request through the native HTTP stack and returns a Fetch Response so
 * existing parsing/error handling stays shared. Web builds retain fetch.
 */
export async function requestCheckPhoneApi(
    url: string,
    apiKey: string,
    payload: Record<string, unknown>,
): Promise<Response> {
    const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey || 'sk-none'}`,
        ...(isOpenCodeGoEndpoint(url) ? { 'x-opencode-session': getOpenCodeSessionId('check-phone') } : {}),
    };
    if (!Capacitor.isNativePlatform()) {
        return fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    }
    const result = await CapacitorHttp.request({
        url,
        method: 'POST',
        headers,
        data: payload,
        connectTimeout: 30_000,
        readTimeout: 90_000,
        responseType: 'json',
    });
    const body = typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? {});
    return new Response(body, {
        status: result.status || 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
}
