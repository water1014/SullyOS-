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
    expect(body.parameters.v4_prompt.caption.base_caption).toBe('1girl, portrait');
    expect(body.parameters.v4_negative_prompt.caption.base_caption).toBe('low quality');
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

  it('keeps the msgpack ZIP route for other third-party NAI gateways', () => {
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
