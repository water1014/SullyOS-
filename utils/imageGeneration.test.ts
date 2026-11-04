import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { editGptImage, generateGptImage, generateNaiImage, normalizeOpenAIImageEditsEndpoint, normalizeOpenAIImagesEndpoint, suggestNaiTags } from './imageGeneration';

afterEach(() => vi.unstubAllGlobals());

describe('image generation clients', () => {
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
});
