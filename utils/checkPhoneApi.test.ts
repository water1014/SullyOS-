import { afterEach, describe, expect, it, vi } from 'vitest';

import { getCheckPhoneApi, resolveCheckPhoneApi, setCheckPhoneApi, requestCheckPhoneApi } from './checkPhoneApi';

const chatDefault = {
    baseUrl: 'https://chat.example/v1',
    apiKey: 'chat-key',
    model: 'chat-model',
    temperature: 0.8,
    maxTokens: 1024,
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('查手机 API 请求通道', () => {
    it('浏览器环境保留标准 fetch，并发送 OpenAI-compatible JSON 请求', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('{"choices":[{"message":{"content":"ok"}}]}', {
            status: 200, headers: { 'Content-Type': 'application/json' },
        }));
        vi.stubGlobal('fetch', fetchMock);
        const response = await requestCheckPhoneApi('https://api.example/v1/chat/completions', 'phone-key', {
            model: 'test-model', messages: [{ role: 'user', content: 'Hi' }],
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ choices: [{ message: { content: 'ok' } }] });
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(fetchMock.mock.calls[0][1]).toMatchObject({
            method: 'POST',
            headers: { Authorization: 'Bearer phone-key', 'Content-Type': 'application/json' },
        });
    });
});

describe('查手机独立 API', () => {
    it('未设置时跟随聊天默认', () => {
        expect(resolveCheckPhoneApi(null, chatDefault)).toBe(chatDefault);
    });

    it('保存独立配置后优先使用，并清理复制进来的边缘空白', () => {
        const values = new Map<string, string>();
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
            removeItem: (key: string) => values.delete(key),
        });
        vi.stubGlobal('window', { dispatchEvent: vi.fn() });
        vi.stubGlobal('CustomEvent', class { constructor(public type: string) {} });

        setCheckPhoneApi({ ...chatDefault, baseUrl: ' https://phone.example/v1/ ', apiKey: ' phone-key ' });
        const saved = getCheckPhoneApi();

        expect(saved).toMatchObject({ baseUrl: 'https://phone.example/v1', apiKey: 'phone-key' });
        expect(resolveCheckPhoneApi(saved, chatDefault)).toBe(saved);
    });

    it('切回默认会删除独立配置', () => {
        const values = new Map<string, string>([['check_phone_api', JSON.stringify(chatDefault)]]);
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
            removeItem: (key: string) => values.delete(key),
        });
        vi.stubGlobal('window', { dispatchEvent: vi.fn() });
        vi.stubGlobal('CustomEvent', class { constructor(public type: string) {} });

        setCheckPhoneApi(null);

        expect(getCheckPhoneApi()).toBeNull();
    });
});

