import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { buildNaiGenerateRequest, generateNaiImage, readNaiImageResponse } from './naiImageAdapter';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('NAI synchronous ZIP generation contract', () => {
  it('sends the explicit msgpack stream mode used by BaiBai and ZhiHuiJi', async () => {
    const request = buildNaiGenerateRequest({
      apiKey: 'test-token',
      model: 'nai-diffusion-4-5-full',
      provider: 'thirdparty',
      baseUrl: 'https://std.loliyc.com/novelai',
    }, '1girl, portrait', 'low quality', {
      width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral', seed: 123,
    });
    const body = JSON.parse(String(request.init.body));
    expect(request.url).toBe('https://std.loliyc.com/novelai/ai/generate-image');
    expect(request.init.method).toBe('POST');
    expect(body.action).toBe('generate');
    expect(body.model).toBe('nai-diffusion-4-5-full');
    expect(body.use_new_shared_trial).toBe(true);
    expect(body.parameters.stream).toBe('msgpack');
    expect(body.parameters.v4_prompt.caption.base_caption).toBe('1girl, portrait');
    expect(body.parameters.v4_negative_prompt.caption.base_caption).toBe('low quality');
    expect(new Headers(request.init.headers).get('authorization')).toBe('Bearer test-token');
  });


  it('retries the Android OkHttp unexpected-end-of-stream transport failure once', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const zip = new JSZip();
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    zip.file('image.png', png);
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('unexpected end of stream on com.android.okhttp.Address@2f94f001'))
      .mockResolvedValueOnce(new Response(bytes, { status: 201, headers: { 'content-type': 'application/zip' } }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = generateNaiImage({
      apiKey: 'test-token', model: 'nai-diffusion-4-5-full', provider: 'thirdparty',
      baseUrl: 'https://std.loliyc.com/novelai',
    }, '1girl, portrait', '', {
      width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral', seed: 123,
    });
    await vi.advanceTimersByTimeAsync(1000);
    const image = await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(image.type).toBe('image/png');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
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
