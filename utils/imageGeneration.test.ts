import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { editGptImage, generateGptImage, generateNaiImage, normalizeOpenAIImageEditsEndpoint, normalizeOpenAIImagesEndpoint, normalizeNaiGenerateEndpoint, buildImageRequestHeaders, suggestNaiTags, getNaiQualityTags, testGptImageConnection, testNaiImageConnection } from './imageGeneration';

afterEach(() => vi.unstubAllGlobals());

describe('image generation clients', () => {
  it('merges optional custom request headers and validates their JSON', () => {
    const headers = buildImageRequestHeaders({ Authorization: 'Bearer standard', 'Content-Type': 'application/json' }, '{"x-api-key":"custom","Authorization":"Bearer override"}');
    expect(headers.get('x-api-key')).toBe('custom');
    expect(headers.get('authorization')).toBe('Bearer override');
    expect(() => buildImageRequestHeaders({}, 'not-json')).toThrow('合法 JSON 对象');
    expect(() => buildImageRequestHeaders({}, '[]')).toThrow('JSON 对象');
  });

  it('tests OpenAI-compatible credentials through the non-billable models endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await testGptImageConnection({
      baseUrl: 'https://api.example/v1/',
      apiKey: 'test-key',
      model: 'image-model',
      customHeaders: '{"x-provider":"studio"}',
    });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('https://api.example/v1/models', expect.objectContaining({
      method: 'GET',
      headers: expect.any(Headers),
    }));
    expect(fetchMock.mock.calls[0][1].headers.get('x-provider')).toBe('studio');
  });

  it('reports GPT authentication failures with their HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":{"message":"invalid token"}}', { status: 401 })));
    const result = await testGptImageConnection({ baseUrl: 'https://api.example/v1', apiKey: 'bad', model: 'image-model' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.message).toContain('invalid token');
  });

  it('validates NovelAI official tokens without starting image generation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"tier":"opus"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await testNaiImageConnection({ provider: 'official', apiKey: 'pst-test', model: 'nai-diffusion-5-full' });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('https://api.novelai.net/user/subscription', expect.objectContaining({ method: 'GET' }));
  });

  it('checks third-party NovelAI endpoint reachability without sending a generation request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await testNaiImageConnection({
      provider: 'thirdparty', baseUrl: 'https://nai-proxy.example', apiKey: 'proxy-token', model: 'nai-model',
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('实际生图确认');
    expect(fetchMock).toHaveBeenCalledWith('https://nai-proxy.example/ai/generate-image', expect.objectContaining({ method: 'OPTIONS' }));
  });

  it('does not report a missing third-party generation route as a successful check', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not found', { status: 404 })));
    const result = await testNaiImageConnection({
      provider: 'thirdparty', baseUrl: 'https://nai-proxy.example', apiKey: 'proxy-token', model: 'nai-model',
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.message).toContain('生图路径返回 404');
  });

  it('normalizes NovelAI official and third-party generation endpoints', () => {
    expect(normalizeNaiGenerateEndpoint('https://image.novelai.net')).toBe('https://image.novelai.net/ai/generate-image');
    expect(normalizeNaiGenerateEndpoint('https://proxy.example///', 'thirdparty')).toBe('https://proxy.example/ai/generate-image');
    expect(normalizeNaiGenerateEndpoint('https://proxy.example/api', 'thirdparty')).toBe('https://proxy.example/api/ai/generate-image');
    expect(normalizeNaiGenerateEndpoint('https://proxy.example/ai/generate-image', 'thirdparty')).toBe('https://proxy.example/ai/generate-image');
    expect(() => normalizeNaiGenerateEndpoint('', 'thirdparty')).toThrow('请填写 NAI 第三方 API Base URL');
  });

  it('normalizes an OpenAI-compatible images endpoint', () => {
    expect(normalizeOpenAIImagesEndpoint('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/images/generations');
    expect(normalizeOpenAIImagesEndpoint('https://proxy.example/v1/images/generations')).toBe('https://proxy.example/v1/images/generations');
  });

  it('normalizes the GPT image edits endpoint', () => {
    expect(normalizeOpenAIImageEditsEndpoint('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/images/edits');
    expect(normalizeOpenAIImageEditsEndpoint('https://proxy.example/v1/images/edits')).toBe('https://proxy.example/v1/images/edits');
  });

  it('sends an uploaded reference image to GPT edits and decodes the result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: btoa('edited-png') }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const source = new Blob(['source-png'], { type: 'image/png' });
    const result = await editGptImage(
      { baseUrl: 'https://api.example/v1', apiKey: 'test-key', model: 'gpt-image-2' },
      source,
      '把天空改成蓝色',
      { size: '1024x1024', quality: 'high' },
    );

    expect(result.type).toBe('image/png');
    expect(await result.text()).toBe('edited-png');
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example/v1/images/edits');
    const body = JSON.parse(String(request.body));
    expect(body).toMatchObject({ model: 'gpt-image-2', prompt: '把天空改成蓝色', n: 1 });
    expect(body.images[0].image_url).toBe(`data:image/png;base64,${btoa('source-png')}`);
  });

  it('decodes GPT Image base64 output into a PNG Blob', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: btoa('fake-png') }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const blob = await generateGptImage(
      { baseUrl: 'https://api.example/v1', apiKey: 'test-key', model: 'gpt-image-2' },
      'a little blue house',
      { size: '1024x1024', quality: 'high' },
    );

    expect(blob.type).toBe('image/png');
    expect(await blob.text()).toBe('fake-png');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, request] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(request.body))).toMatchObject({ model: 'gpt-image-2', n: 1, prompt: 'a little blue house' });
  });

  it('downloads image URLs returned by OpenAI-compatible providers', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: 'https://images.example/result.png' }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(new Blob(['url-image'], { type: 'image/png' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const blob = await generateGptImage(
      { baseUrl: 'https://api.example/v1', apiKey: 'test-key', model: 'compatible-image-model' },
      'a moonlit garden',
      { size: '1024x1024', quality: 'high' },
    );

    expect(blob.type).toBe('image/png');
    expect(await blob.text()).toBe('url-image');
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://images.example/result.png');
  });

  it('accepts direct binary image responses from compatible providers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(new Blob(['direct-image'], { type: 'image/webp' }), { status: 200 }),
    ));
    const blob = await generateGptImage(
      { baseUrl: 'https://api.example/v1', apiKey: 'test-key', model: 'compatible-image-model' },
      'a quiet lake',
      { size: '1024x1024', quality: 'high' },
    );
    expect(blob.type).toBe('image/webp');
    expect(await blob.text()).toBe('direct-image');
  });

  it('extracts the first image from NovelAI ZIP output', async () => {
    const zip = new JSZip();
    zip.file('image_0.png', 'nai-png');
    const archive = await zip.generateAsync({ type: 'uint8array' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(archive, { status: 200 })));

    const blob = await generateNaiImage(
      { apiKey: 'thirdparty-token', model: 'nai-diffusion-5-full', provider: 'thirdparty', baseUrl: 'https://nai-proxy.example', customHeaders: '{"x-provider":"studio-test"}' },
      '1girl, blue hair',
      'blurry',
      { width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral', seed: 0 },
    );

    expect(await blob.text()).toBe('nai-png');
    const [url, request] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://nai-proxy.example/ai/generate-image');
    expect(request.headers.get('Authorization')).toBe('Bearer thirdparty-token');
    expect(request.headers.get('x-provider')).toBe('studio-test');
    expect(JSON.parse(String(request.body))).toMatchObject({
      action: 'generate',
      model: 'nai-diffusion-5-full',
      parameters: { width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral', seed: 0, negative_prompt: 'blurry' },
    });
  });

  it('passes cancellation signals through to GPT generation requests', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Blob(['image'], { type: 'image/png' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await generateGptImage(
      { baseUrl: 'https://api.example/v1', apiKey: 'test-key', model: 'gpt-image-2' },
      'test image',
      { size: '1024x1024', quality: 'high', signal: controller.signal },
    );
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it('passes cancellation signals through to NovelAI generation requests', async () => {
    const controller = new AbortController();
    const zip = new JSZip();
    zip.file('image_0.png', 'nai-png');
    const archive = await zip.generateAsync({ type: 'uint8array' });
    const fetchMock = vi.fn().mockResolvedValue(new Response(archive, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await generateNaiImage(
      { apiKey: 'pst-test', model: 'nai-diffusion-5-full', provider: 'official' },
      '1girl',
      '',
      { width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral' },
      controller.signal,
    );
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it('rejects successful NovelAI responses that contain no image in the ZIP', async () => {
    const zip = new JSZip();
    zip.file('readme.txt', 'not an image');
    const archive = await zip.generateAsync({ type: 'uint8array' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(archive, { status: 200 })));
    await expect(generateNaiImage(
      { apiKey: 'pst-test', model: 'nai-diffusion-5-full', provider: 'official' },
      '1girl',
      '',
      { width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral' },
    )).rejects.toThrow('压缩包中没有找到图片文件');
  });

  it('surfaces provider errors instead of silently returning an empty image', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'invalid api key' },
    }), { status: 401 })));

    await expect(generateGptImage(
      { baseUrl: 'https://api.example/v1', apiKey: 'bad', model: 'gpt-image-2' },
      'test',
      { size: '1024x1024', quality: 'high' },
    )).rejects.toThrow('invalid api key');
  });

  it('requests NovelAI tag suggestions with the selected model and token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      tags: [
        { tag: 'blue hair', count: 1200, confidence: 0.98 },
        { tag: 'blue eyes', count: 900, confidence: 0.87 },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const suggestions = await suggestNaiTags(
      { apiKey: 'pst-test', model: 'nai-diffusion-5-full', customHeaders: '{"x-tag-test":"enabled"}' },
      'blue',
    );

    expect(suggestions.map(item => item.tag)).toEqual(['blue hair', 'blue eyes']);
    const [url, request] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/ai/generate-image/suggest-tags?');
    expect(String(url)).toContain('model=nai-diffusion-5-full');
    expect(String(url)).toContain('prompt=blue');
    expect(request.headers.get('Authorization')).toBe('Bearer pst-test');
    expect(request.headers.get('x-tag-test')).toBe('enabled');
  });

  it('rejects NovelAI tag suggestions without a persistent token', async () => {
    await expect(suggestNaiTags(
      { apiKey: '', model: 'nai-diffusion-5-full' },
      'blue',
    )).rejects.toThrow('Persistent API Token');
  });

  it('uses the official V5 Full quality tag combinations', () => {
    expect(getNaiQualityTags('nai-diffusion-5-full', 'light')).toEqual(['very aesthetic', 'amazing quality', 'no text']);
    expect(getNaiQualityTags('nai-diffusion-5-full', 'standard')).toEqual(['very aesthetic', 'masterpiece', 'no text']);
  });

  it('uses the official V5 Curated quality tag combinations', () => {
    expect(getNaiQualityTags('nai-diffusion-5-curated', 'standard')).toEqual(['very aesthetic', 'masterpiece', 'no text']);
  });

  it('uses the V4.5 Full and Curated model-specific quality tags', () => {
    expect(getNaiQualityTags('nai-diffusion-4-5-full', 'standard')).toEqual(['location', 'very aesthetic', 'masterpiece', 'no text']);
    expect(getNaiQualityTags('nai-diffusion-4-5-curated', 'standard')).toEqual(['location', 'masterpiece', 'no text', '-0.8::feet::', 'rating:general']);
  });

});
