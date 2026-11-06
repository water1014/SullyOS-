import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { buildNaiGenerateRequest, generateNaiImage, readNaiImageResponse } from './naiImageAdapter';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('NAI synchronous ZIP generation contract', () => {
  it('uses Morpho second-mod route and standard JSON payload for loliyc /novelai', () => {
    const request = buildNaiGenerateRequest({
      apiKey: 'test-token', model: 'nai-diffusion-4-5-full', provider: 'thirdparty',
      baseUrl: 'https://std.loliyc.com/novelai',
    }, '1girl, portrait', 'low quality', {
      width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral', seed: 123,
    });
    const body = JSON.parse(String(request.init.body));
    expect(request.url).toBe('https://std.loliyc.com/novelai');
    expect(body.action).toBe('generate');
    expect(body.model).toBe('nai-diffusion-4-5-full');
    expect(body.use_new_shared_trial).toBeUndefined();
    expect(body.parameters.stream).toBeUndefined();
    expect(body.parameters.params_version).toBe(3);
    expect(body.parameters.dynamic_thresholding).toBe(false);
    expect(body.parameters.controlnet_strength).toBe(1);
    expect(body.parameters.legacy).toBe(false);
    expect(body.parameters.use_coords).toBe(false);
    expect(body.parameters.characterPrompts).toEqual([]);
    expect(body.parameters.reference_image_multiple).toEqual([]);
    expect(body.parameters.v4_prompt).toMatchObject({ caption: { base_caption: '1girl, portrait', char_captions: [] }, use_coords: false, use_order: true });
    expect(body.parameters.v4_negative_prompt).toMatchObject({ caption: { base_caption: 'low quality', char_captions: [] }, legacy_uc: false });
    expect(new Headers(request.init.headers).get('authorization')).toBe('Bearer test-token');
    expect(new Headers(request.init.headers).get('accept')).toBe('application/zip, application/json, image/*');

    const legacySugarPath = buildNaiGenerateRequest({
      apiKey: 'test-token', model: 'nai-diffusion-4-5-full', provider: 'thirdparty',
      baseUrl: 'https://std.loliyc.com/api/generate',
    }, '1girl, portrait', '', {
      width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral', seed: 123,
    });
    expect(legacySugarPath.url).toBe('https://std.loliyc.com/novelai');
  });

  it('normalizes a trailing /v1 like OVO and keeps official NAI requests free of third-party gateway hints', () => {
    const request = buildNaiGenerateRequest({
      apiKey: 'test-token', model: 'nai-diffusion-4-5-full', provider: 'official',
      baseUrl: 'https://api.example/v1',
    }, '1girl, portrait', '', {
      width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral', seed: 123,
    });
    const body = JSON.parse(String(request.init.body));
    expect(request.url).toBe('https://api.example/ai/generate-image');
    expect(body.use_new_shared_trial).toBeUndefined();
    expect(body.parameters.stream).toBeUndefined();
    expect(body.parameters.add_original_image).toBe(true);
  });

  it('uses the 智绘姬-compatible msgpack hint for generic third-party gateways without changing the ZIP response contract', () => {
    const request = buildNaiGenerateRequest({
      apiKey: 'test-token', model: 'nai-diffusion-4-5-full', provider: 'thirdparty',
      baseUrl: 'https://proxy.example',
    }, '1girl, portrait', '', {
      width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral', seed: 123,
    });
    const body = JSON.parse(String(request.init.body));
    expect(request.url).toBe('https://proxy.example/ai/generate-image');
    expect(body.use_new_shared_trial).toBe(true);
    expect(body.parameters.stream).toBe('msgpack');
  });


  it('extracts image data URLs nested anywhere in a JSON response, like OVO', async () => {
    const response = new Response(JSON.stringify({
      result: { message: 'generation complete', images: ['data:image/png;base64,iVBORw0KGgo='] },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const image = await readNaiImageResponse(response);
    expect(image.type).toBe('image/png');
    expect(new Uint8Array(await image.arrayBuffer()).slice(0, 8)).toEqual(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    );
  });

  it('follows image URLs embedded in a JSON response, like OVO', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(png, {
      status: 200, headers: { 'content-type': 'image/png' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const response = new Response(JSON.stringify({
      data: [{ url: 'https://cdn.example.test/generated/image.png?token=redacted' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const image = await readNaiImageResponse(response);
    expect(fetchMock).toHaveBeenCalledWith('https://cdn.example.test/generated/image.png?token=redacted');
    expect(image.type).toBe('image/png');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
  });

  it('does not resend an ambiguous Android stream failure that may already have been billed', async () => {
    const fetchMock = vi.fn().mockRejectedValue(
      new Error('unexpected end of stream on com.android.okhttp.Address@test'),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateNaiImage({
      apiKey: 'test-token', model: 'nai-diffusion-4-5-full', provider: 'thirdparty',
      baseUrl: 'https://std.loliyc.com/novelai',
    }, '1girl, portrait', '', {
      width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral', seed: 123,
    })).rejects.toThrow(/unexpected end of stream/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads the returned ZIP as raw bytes and extracts its image entry', async () => {
    const zip = new JSZip();
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    zip.file('image.png', png);
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const response = new Response(bytes, { status: 201, headers: { 'content-type': 'application/zip' } });
    const image = await readNaiImageResponse(response);
    expect(image.type).toBe('image/png');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
  });
});
