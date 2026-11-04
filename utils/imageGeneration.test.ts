import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { editGptImage, generateGptImage, generateNaiImage, normalizeOpenAIImageEditsEndpoint, normalizeOpenAIImagesEndpoint, normalizeNaiGenerateEndpoint, suggestNaiTags, getNaiQualityTags } from './imageGeneration';

afterEach(() => vi.unstubAllGlobals());

describe('image generation clients', () => {
  it('normalizes NovelAI official and third-party generation endpoints', () => {
    expect(normalizeNaiGenerateEndpoint('https://image.novelai.net')).toBe('https://image.novelai.net/ai/generate-image');
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

  it('extracts the first image from NovelAI ZIP output', async () => {
    const zip = new JSZip();
    zip.file('image_0.png', 'nai-png');
    const archive = await zip.generateAsync({ type: 'uint8array' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(archive, { status: 200 })));

    const blob = await generateNaiImage(
      { apiKey: 'pst-test', model: 'nai-diffusion-5-full' },
      '1girl, blue hair',
      'blurry',
      { width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral' },
    );

    expect(await blob.text()).toBe('nai-png');
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
      { apiKey: 'pst-test', model: 'nai-diffusion-5-full' },
      'blue',
    );

    expect(suggestions.map(item => item.tag)).toEqual(['blue hair', 'blue eyes']);
    const [url, request] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/ai/generate-image/suggest-tags?');
    expect(String(url)).toContain('model=nai-diffusion-5-full');
    expect(String(url)).toContain('prompt=blue');
    expect(request.headers.Authorization).toBe('Bearer pst-test');
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
