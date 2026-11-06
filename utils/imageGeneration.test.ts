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
    expect(() => normalizeNaiGenerateEndpoint('file:///tmp/nai', 'thirdparty')).toThrow('只支持 HTTP 或 HTTPS');
    expect(normalizeNaiGenerateEndpoint('https://proxy.example/api/ai/generate-image?token=abc', 'thirdparty')).toBe('https://proxy.example/api/ai/generate-image?token=abc');
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

  it('downloads image URLs returned by OpenAI-compatible providers with the task cancellation signal', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: 'https://images.example/result.png' }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(new Blob(['url-image'], { type: 'image/png' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const blob = await generateGptImage(
      { baseUrl: 'https://api.example/v1', apiKey: 'test-key', model: 'compatible-image-model' },
      'a moonlit garden',
      { size: '1024x1024', quality: 'high', signal: controller.signal },
    );

    expect(blob.type).toBe('image/png');
    expect(await blob.text()).toBe('url-image');
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://images.example/result.png', { signal: controller.signal });
  });

  it('accepts direct binary image responses from compatible providers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(new Blob([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkyoAAAAASUVORK5CYII='), char => char.charCodeAt(0))], { type: 'image/png' }), { status: 200 }),
    ));
    const blob = await generateGptImage(
      { baseUrl: 'https://api.example/v1', apiKey: 'test-key', model: 'compatible-image-model' },
      'a quiet lake',
      { size: '1024x1024', quality: 'high' },
    );
    expect(blob.type).toBe('image/png');
    expect(new Uint8Array(await blob.arrayBuffer()).slice(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  it('uses the original synchronous NAI ZIP request contract', async () => {
    const zip = new JSZip();
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkyoAAAAASUVORK5CYII='), char => char.charCodeAt(0));
    zip.file('image_0.png', png);
    const archive = await zip.generateAsync({ type: 'uint8array' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(archive, { status: 200 })));

    await generateNaiImage(
      { apiKey: 'pst-test', model: 'nai-diffusion-4-5-full', provider: 'official' },
      'blue hair',
      '',
      { width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral', seed: 1 },
    );

    const [, request] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(String(request.body));
    expect(body.parameters).toHaveProperty('stream', 'msgpack');
    expect(body.parameters).toHaveProperty('ucPreset', 0);
    expect(new Headers(request.headers).get('Accept')).toBe('application/zip');
  });

  it('decodes NovelAI JSON base64 image responses from third-party gateways', async () => {
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkyoAAAAASUVORK5CYII=';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      images: [{ image: pngBase64, index: 0, seed: 123 }],
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const blob = await generateNaiImage(
      { apiKey: 'thirdparty-token', model: 'nai-diffusion-4-5-full', provider: 'thirdparty', baseUrl: 'https://nai-proxy.example' },
      '1girl, blue hair',
      '',
      { width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral', seed: 123 },
    );

    expect(blob.type).toBe('image/png');
    expect(new Uint8Array(await blob.arrayBuffer()).slice(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('Accept')).toBe('*/*');
  });

  it('extracts the first image from NovelAI ZIP output', async () => {
    const zip = new JSZip();
    zip.file('image_0.png', Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkyoAAAAASUVORK5CYII='), char => char.charCodeAt(0)));
    const archive = await zip.generateAsync({ type: 'uint8array' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(archive, { status: 200 })));

    const blob = await generateNaiImage(
      { apiKey: 'sk-test', model: 'nai-diffusion-4-5-full', provider: 'thirdparty', baseUrl: 'https://std.loliyc.com/novelai', customHeaders: '{"x-provider":"studio-test"}' },
      '1girl, blue hair',
      'blurry',
      { width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral', seed: 0 },
    );

    expect(blob.type).toBe('image/png');
    expect(new Uint8Array(await blob.arrayBuffer()).slice(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    const [url, request] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://std.loliyc.com/novelai');
    expect(new Headers(request.headers).get('Authorization')).toBe('Bearer sk-test');
    expect(new Headers(request.headers).get('x-provider')).toBe('studio-test');
    expect(new Headers(request.headers).get('Accept')).toBe('application/zip, application/json, image/*');
    const requestBody = JSON.parse(String(request.body));
    expect(requestBody.parameters.stream).toBeUndefined();
    expect(requestBody).toMatchObject({
      action: 'generate',
      model: 'nai-diffusion-4-5-full',
      parameters: {
        width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral',
        seed: 0, negative_prompt: 'blurry', ucPreset: 0, params_version: 3,
        cfg_rescale: 0, qualityToggle: true, noise_schedule: 'karras', n_samples: 1,
      },
    });
    expect(requestBody.parameters).not.toHaveProperty('dynamic_thresholding');
  });

  it('rejects a damaged single-image NAI ZIP instead of rewriting its metadata', async () => {
    const zip = new JSZip();
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkyoAAAAASUVORK5CYII='), char => char.charCodeAt(0));
    zip.file('image_0.png', png);
    const archive = new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
    const damaged = archive.slice();
    const findSignature = (a: number, b: number, c: number, d: number) => {
      for (let index = 0; index <= damaged.length - 4; index += 1) {
        if (damaged[index] === a && damaged[index + 1] === b
          && damaged[index + 2] === c && damaged[index + 3] === d) return index;
      }
      return -1;
    };
    const eocd = findSignature(0x50, 0x4b, 0x05, 0x06);
    expect(eocd).toBeGreaterThan(0);
    // Corrupt the EOCD central-directory offset and local-header compressed size.
    damaged.fill(0xff, eocd + 16, eocd + 20);
    const centralSize = damaged[eocd + 12] | (damaged[eocd + 13] << 8)
      | (damaged[eocd + 14] << 16) | (damaged[eocd + 15] << 24);
    const centralOffset = eocd - (centralSize >>> 0);
    damaged.fill(0xff, centralOffset + 42, centralOffset + 46);
    damaged[eocd + 20] = 0x1b;
    damaged[eocd + 21] = 0x00;
    damaged.fill(0xff, 18, 22);
    // The damaged response retains two trailing comment bytes, as in the phone diagnostic.
    const withTrailingBytes = new Uint8Array(damaged.length + 2);
    withTrailingBytes.set(damaged);
    withTrailingBytes.set([0x00, 0x00], damaged.length);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(withTrailingBytes, {
      status: 200, headers: { 'Content-Type': 'application/zip' },
    })));

    await expect(generateNaiImage(
      { apiKey: 'proxy-token', model: 'nai-diffusion-4-5-full', provider: 'thirdparty', baseUrl: 'https://nai-proxy.example' },
      'blue hair',
      '',
      { width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral', seed: 1 },
    )).rejects.toThrow('未修改响应元数据');
  });

  it('recovers an intact NAI image from local ZIP headers when the EOCD directory offset is damaged', async () => {
    const zip = new JSZip();
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkyoAAAAASUVORK5CYII='), char => char.charCodeAt(0));
    zip.file('image_0.png', png);
    const archive = new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
    let eocd = -1;
    for (let index = archive.length - 22; index >= Math.max(0, archive.length - 22 - 0xffff); index -= 1) {
      if (archive[index] === 0x50 && archive[index + 1] === 0x4b
        && archive[index + 2] === 0x05 && archive[index + 3] === 0x06) {
        eocd = index;
        break;
      }
    }
    expect(eocd).toBeGreaterThan(0);
    const damaged = archive.slice();
    damaged.fill(0xff, eocd + 16, eocd + 20);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(damaged, {
      status: 200, headers: { 'Content-Type': 'application/zip' },
    })));

    const blob = await generateNaiImage(
      { apiKey: 'proxy-token', model: 'nai-diffusion-4-5-full', provider: 'thirdparty', baseUrl: 'https://nai-proxy.example' },
      'blue hair',
      '',
      { width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral', seed: 1 },
    );
    expect(blob.type).toBe('image/png');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(png);
  });

  it('rejects ZIP data with a damaged central directory even when a signature record exists', async () => {
    const zip = new JSZip();
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkyoAAAAASUVORK5CYII='), char => char.charCodeAt(0));
    zip.file('image_0.png', png);
    const original = new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
    const findSignature = (bytes: Uint8Array, a: number, b: number, c: number, d: number) => {
      for (let index = 0; index <= bytes.length - 4; index += 1) {
        if (bytes[index] === a && bytes[index + 1] === b
          && bytes[index + 2] === c && bytes[index + 3] === d) return index;
      }
      return -1;
    };
    const originalEocd = findSignature(original, 0x50, 0x4b, 0x05, 0x06);
    expect(originalEocd).toBeGreaterThan(0);
    const withSignature = new Uint8Array(original.length + 8);
    withSignature.set(original.subarray(0, originalEocd));
    // PK0505 + two-byte payload length + two payload bytes.
    withSignature.set([0x50, 0x4b, 0x05, 0x05, 0x02, 0x00, 0xaa, 0xbb], originalEocd);
    withSignature.set(original.subarray(originalEocd), originalEocd + 8);

    const damaged = withSignature.slice();
    const eocd = originalEocd + 8;
    damaged.fill(0xff, eocd + 16, eocd + 20);
    damaged[eocd + 20] = 0x1b;
    damaged[eocd + 21] = 0x00;
    damaged.fill(0xff, 18, 22);
    const withTrailingBytes = new Uint8Array(damaged.length + 2);
    withTrailingBytes.set(damaged);
    withTrailingBytes.set([0x00, 0x00], damaged.length);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(withTrailingBytes, {
      status: 200, headers: { 'Content-Type': 'application/zip' },
    })));

    await expect(generateNaiImage(
      { apiKey: 'proxy-token', model: 'nai-diffusion-4-5-full', provider: 'thirdparty', baseUrl: 'https://nai-proxy.example' },
      'blue hair',
      '',
      { width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral', seed: 1 },
    )).rejects.toThrow('未修改响应元数据');
  });

  it('rejects a ZIP whose compressed image bytes fail CRC validation', async () => {
    const zip = new JSZip();
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkyoAAAAASUVORK5CYII='), char => char.charCodeAt(0));
    zip.file('image_0.png', png);
    const damaged = new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
    const nameLength = damaged[26] | (damaged[27] << 8);
    const extraLength = damaged[28] | (damaged[29] << 8);
    const dataStart = 30 + nameLength + extraLength;
    damaged[dataStart + 2] ^= 0x40;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(damaged, {
      status: 200, headers: { 'Content-Type': 'application/zip' },
    })));

    await expect(generateNaiImage(
      { apiKey: 'proxy-token', model: 'nai-diffusion-4-5-full', provider: 'thirdparty', baseUrl: 'https://nai-proxy.example' },
      'blue hair',
      '',
      { width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral', seed: 1 },
    )).rejects.toThrow('NAI 返回 ZIP，但 ZIP 结构或图片校验失败');
  });

  it('keeps legacy JSZip tolerance for noncanonical EOCD metadata without mutating response bytes', async () => {
    const zip = new JSZip();
    zip.file('image_0.png', Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkyoAAAAASUVORK5CYII='), char => char.charCodeAt(0)));
    const archive = await zip.generateAsync({ type: 'uint8array' });
    const compatibleArchive = new Uint8Array(archive);
    // Keep the EOCD signature but use the noncanonical comment length accepted by the old reader.
    const eocd = compatibleArchive.findIndex((value, index) =>
      value === 0x50 && compatibleArchive[index + 1] === 0x4b
      && compatibleArchive[index + 2] === 0x05 && compatibleArchive[index + 3] === 0x06,
    );
    expect(eocd).toBeGreaterThanOrEqual(0);
    compatibleArchive[eocd + 20] = 0x4a;
    compatibleArchive[eocd + 21] = 0x00;
    const originalBytes = compatibleArchive.slice();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(compatibleArchive, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename=images.zip',
      },
    })));
    const blob = await generateNaiImage(
      { apiKey: 'sk-test', model: 'nai-diffusion-4-5-full', provider: 'thirdparty', baseUrl: 'https://std.loliyc.com/novelai' },
      'blue hair',
      '',
      { width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral', seed: 1 },
    );
    expect(blob.type).toBe('image/png');
    expect(new Uint8Array(await blob.arrayBuffer()).slice(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(compatibleArchive).toEqual(originalBytes);
  });

  it('accepts direct image responses from third-party NovelAI gateways', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Blob([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkyoAAAAASUVORK5CYII='), char => char.charCodeAt(0))], { type: 'image/png' }), {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    })));
    const blob = await generateNaiImage(
      { apiKey: 'proxy-token', model: 'nai-model', provider: 'thirdparty', baseUrl: 'https://nai-proxy.example' },
      'blue hair',
      '',
      { width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral', seed: 1 },
    );
    expect(blob.type).toBe('image/png');
    expect(new Uint8Array(await blob.arrayBuffer()).slice(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  it('surfaces JSON error details from gateways that return HTTP 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'model is not enabled for this account' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    await expect(generateNaiImage(
      { apiKey: 'proxy-token', model: 'nai-model', provider: 'thirdparty', baseUrl: 'https://nai-proxy.example' },
      'blue hair',
      '',
      { width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral', seed: 1 },
    )).rejects.toThrow('model is not enabled for this account');
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

  it('rejects invalid NovelAI seeds before making a network request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateNaiImage(
      { apiKey: 'pst-test', model: 'nai-diffusion-5-full', provider: 'official' },
      '1girl',
      '',
      { width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral', seed: 4294967296 },
    )).rejects.toThrow('0 到 4294967295');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes cancellation signals through to NovelAI generation requests', async () => {
    const controller = new AbortController();
    const zip = new JSZip();
    zip.file('image_0.png', Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkyoAAAAASUVORK5CYII='), char => char.charCodeAt(0)));
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
    )).rejects.toThrow('ZIP 中没有 PNG/JPEG/WebP 图片条目');
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
    expect(new Headers(request.headers).get('Authorization')).toBe('Bearer pst-test');
    expect(new Headers(request.headers).get('x-tag-test')).toBe('enabled');
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
