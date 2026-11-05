import JSZip from 'jszip';
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js';

export type ImageEngine = 'gpt' | 'nai';

export interface GptImageConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  customHeaders?: string;
}

export interface NaiImageConfig {
  apiKey: string;
  model: string;
  provider?: 'official' | 'thirdparty';
  baseUrl?: string;
  customHeaders?: string;
}

export interface NaiImageOptions {
  width: number;
  height: number;
  steps: number;
  scale: number;
  sampler: string;
  seed?: number;
}

export interface ImageConnectionTestResult {
  ok: boolean;
  message: string;
  status?: number;
  durationMs: number;
}

function validateProviderUrl(value: string, label: string): string {
  let parsed: URL;
  try { parsed = new URL(value.trim()); }
  catch { throw new Error(`请检查 ${label}，必须是完整的 https:// 地址`); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${label} 只支持 HTTP 或 HTTPS 地址`);
  }
  return parsed.toString().replace(/\/$/, '');
}

async function responseError(response: Response, fallback: string): Promise<string> {
  const raw = await response.text().catch(() => '');
  if (!raw) return fallback;
  try { return String(errorMessage(JSON.parse(raw), fallback)).slice(0, 220); }
  catch { return raw.slice(0, 220); }
}

/** Lightweight credential check for OpenAI-compatible providers. It calls GET /models and never creates an image. */
export async function testGptImageConnection(config: GptImageConfig): Promise<ImageConnectionTestResult> {
  if (!config.apiKey.trim()) throw new Error('请先填写 GPT API Key');
  const base = validateProviderUrl(config.baseUrl, 'GPT API Base URL');
  const headers = buildImageRequestHeaders({ Authorization: `Bearer ${config.apiKey.trim()}`, Accept: 'application/json' }, config.customHeaders);
  const startedAt = Date.now();
  const response = await fetch(`${base}/models`, { method: 'GET', headers });
  const durationMs = Date.now() - startedAt;
  if (response.ok) return { ok: true, status: response.status, durationMs, message: '连接成功，服务商允许访问 /models。图片模型是否可用仍以实际生图为准。' };
  if (response.status === 404 || response.status === 405) {
    return { ok: true, status: response.status, durationMs, message: '服务地址可达，但未开放 /models 检查接口。请用一次实际生成验证图片模型。' };
  }
  return { ok: false, status: response.status, durationMs, message: await responseError(response, `连接失败（HTTP ${response.status}）`) };
}

/** NovelAI official subscription endpoint validates the persistent token without generating an image. */
export async function testNaiImageConnection(config: NaiImageConfig): Promise<ImageConnectionTestResult> {
  if (!config.apiKey.trim()) throw new Error('请先填写 NovelAI / NAI API Token');
  const provider = config.provider || 'official';
  const startedAt = Date.now();
  if (provider === 'official') {
    const response = await fetch('https://api.novelai.net/user/subscription', {
      method: 'GET',
      headers: buildImageRequestHeaders({
        Authorization: `Bearer ${config.apiKey.trim()}`,
        Accept: 'application/json',
      }, config.customHeaders),
    });
    const durationMs = Date.now() - startedAt;
    if (response.ok) return { ok: true, status: response.status, durationMs, message: 'NovelAI 官方接口连接成功，Persistent Token 已通过验证。' };
    return { ok: false, status: response.status, durationMs, message: await responseError(response, `NovelAI 验证失败（HTTP ${response.status}）`) };
  }

  const endpoint = normalizeNaiGenerateEndpoint(config.baseUrl || '', 'thirdparty');
  // Third-party NovelAI-compatible services do not share a standard auth/health endpoint.
  // OPTIONS checks reachability only; it deliberately does not send a generation payload or spend credits.
  const response = await fetch(endpoint, { method: 'OPTIONS', headers: { Accept: 'application/json' } });
  const durationMs = Date.now() - startedAt;
  if (response.status === 404) {
    return { ok: false, status: response.status, durationMs, message: '服务器已响应，但生图路径返回 404。请检查第三方 Base URL 是否正确，以及服务商是否提供 NovelAI 原生协议。' };
  }
  if (response.status < 500) {
    return {
      ok: true,
      status: response.status,
      durationMs,
      message: '服务地址已响应。第三方没有统一的鉴权测试协议，此检查不验证 Token 和模型，仍需通过实际生图确认。',
    };
  }
  return { ok: false, status: response.status, durationMs, message: `第三方服务返回服务器错误（HTTP ${response.status}）` };
}

export function buildImageRequestHeaders(base: Record<string, string>, customHeaders = ''): Headers {
  const headers = new Headers(base);
  if (!customHeaders.trim()) return headers;
  let parsed: unknown;
  try { parsed = JSON.parse(customHeaders); }
  catch { throw new Error('额外请求头必须是合法 JSON 对象'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('额外请求头必须是 JSON 对象，例如 {"x-api-key":"你的密钥"}');
  }
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string' || !name.trim() || /[\r\n]/.test(name + value)) {
      throw new Error('额外请求头的名称和值必须是有效字符串');
    }
    headers.set(name.trim(), value);
  }
  return headers;
}

function errorMessage(payload: any, fallback: string): string {
  return payload?.error?.message || payload?.message || payload?.detail || payload?.error || fallback;
}

export function normalizeOpenAIImagesEndpoint(baseUrl: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, '');
  if (!clean) throw new Error('请填写 GPT API Base URL');
  return clean.endsWith('/images/generations') ? clean : `${clean}/images/generations`;
}

export function normalizeOpenAIImageEditsEndpoint(baseUrl: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, '');
  if (!clean) throw new Error('请填写 GPT API Base URL');
  return clean.endsWith('/images/edits') ? clean : `${clean}/images/edits`;
}

async function readGptImageResponse(response: Response, actionLabel: string, signal?: AbortSignal): Promise<Blob> {
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(errorMessage(payload, `${actionLabel}失败（HTTP ${response.status}）`));
  }

  const contentType = response.headers.get('Content-Type') || '';
  if (contentType.toLowerCase().startsWith('image/')) return response.blob();

  const payload = await response.json().catch(() => null);
  const encoded = payload?.data?.[0]?.b64_json;
  if (typeof encoded === 'string' && encoded) {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: 'image/png' });
  }

  const imageUrl = payload?.data?.[0]?.url;
  if (typeof imageUrl === 'string' && imageUrl) {
    const imageResponse = await fetch(imageUrl, { signal });
    if (!imageResponse.ok) throw new Error(`${actionLabel}返回了图片链接，但下载失败（HTTP ${imageResponse.status}）`);
    const blob = await imageResponse.blob();
    if (!blob.type.toLowerCase().startsWith('image/')) {
      throw new Error(`${actionLabel}返回的链接不是可识别的图片文件`);
    }
    return blob;
  }

  throw new Error(`${actionLabel}没有返回图片数据。请确认服务支持 OpenAI Images API，并返回 b64_json、url 或图片文件。`);
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  const mimeType = blob.type || 'image/png';
  return `data:${mimeType};base64,${btoa(binary)}`;
}

/** Edit an uploaded reference image through the OpenAI-compatible Images Edits API. */
export async function editGptImage(
  config: GptImageConfig,
  image: Blob,
  prompt: string,
  options: { size: string; quality: string; negativePrompt?: string; signal?: AbortSignal },
): Promise<Blob> {
  if (!config.apiKey.trim()) throw new Error('请先填写 GPT 生图 API Key');
  if (!prompt.trim()) throw new Error('请写下希望如何修改参考图');
  if (!image.type.startsWith('image/')) throw new Error('参考文件必须是图片');
  if (image.size > 20 * 1024 * 1024) throw new Error('参考图片不能超过 20 MB');

  const imageUrl = await blobToDataUrl(image);
  const response = await fetch(normalizeOpenAIImageEditsEndpoint(config.baseUrl), {
    method: 'POST',
    headers: buildImageRequestHeaders({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey.trim()}`,
    }, config.customHeaders),
    body: JSON.stringify({
      model: config.model || 'gpt-image-2.5-flare',
      images: [{ image_url: imageUrl }],
      prompt: prompt.trim(),
      ...(options.negativePrompt?.trim() ? { negative_prompt: options.negativePrompt.trim() } : {}),
      size: options.size,
      quality: options.quality,
      n: 1,
      output_format: 'png',
    }),
    signal: options.signal,
  });
  return readGptImageResponse(response, 'GPT 图片编辑', options.signal);
}

export async function generateGptImage(
  config: GptImageConfig,
  prompt: string,
  options: { size: string; quality: string; negativePrompt?: string; signal?: AbortSignal },
): Promise<Blob> {
  if (!config.apiKey.trim()) throw new Error('请先填写 GPT 生图 API Key');
  if (!prompt.trim()) throw new Error('先写下你想生成的画面吧');
  const response = await fetch(normalizeOpenAIImagesEndpoint(config.baseUrl), {
    method: 'POST',
    headers: buildImageRequestHeaders({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey.trim()}`,
    }, config.customHeaders),
    body: JSON.stringify({
      model: config.model || 'gpt-image-2.5-flare',
      prompt: prompt.trim(),
      ...(options.negativePrompt?.trim() ? { negative_prompt: options.negativePrompt.trim() } : {}),
      size: options.size,
      quality: options.quality,
      n: 1,
      output_format: 'png',
    }),
    signal: options.signal,
  });
  return readGptImageResponse(response, 'GPT 生图', options.signal);
}

export function normalizeNaiGenerateEndpoint(baseUrl: string, provider: 'official' | 'thirdparty' = 'official'): string {
  const raw = baseUrl.trim() || (provider === 'official' ? 'https://image.novelai.net' : '');
  if (!raw) throw new Error('请填写 NAI 第三方 API Base URL');
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { throw new Error('NAI API Base URL 必须是完整的 http:// 或 https:// 地址'); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('NAI API Base URL 只支持 HTTP 或 HTTPS 地址');
  }
  const basePath = parsed.pathname.replace(/^\/+|\/+$/g, '');
  const hasGenerationPath = basePath === 'ai/generate-image' || basePath.endsWith('/ai/generate-image');
  parsed.pathname = hasGenerationPath
    ? `/${basePath}`
    : basePath ? `/${basePath}/ai/generate-image` : '/ai/generate-image';
  return parsed.toString().replace(/\/$/, '');
}

function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

function findNaiBase64(value: unknown, depth = 0): { encoded: string; mimeType?: string } | null {
  if (depth > 5 || !value || typeof value !== 'object') return null;
  const object = value as Record<string, unknown>;
  const mimeType = typeof object.mime_type === 'string' ? object.mime_type
    : typeof object.mimeType === 'string' ? object.mimeType : undefined;
  for (const key of ['image', 'image_base64', 'base64', 'b64_json', 'output', 'result']) {
    const candidate = object[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      const match = candidate.trim().match(/^(?:data:(image\/[a-z0-9.+-]+);base64,)?([a-z0-9+/=_\-\s]+)$/i);
      if (match && match[2].replace(/\s/g, '').length > 0) {
        return { encoded: match[2].replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/'), mimeType: match[1] || mimeType };
      }
    }
    if (candidate && typeof candidate === 'object') {
      const nested = findNaiBase64(candidate, depth + 1);
      if (nested) return nested;
    }
  }
  for (const key of ['data', 'images', 'artifacts', 'response']) {
    const candidate = object[key];
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const nested = findNaiBase64(item, depth + 1);
        if (nested) return nested;
      }
    } else if (candidate && typeof candidate === 'object') {
      const nested = findNaiBase64(candidate, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

async function readNaiImageResponse(response: Response): Promise<Blob> {
  const contentType = (response.headers.get('Content-Type') || '').toLowerCase();
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (!buffer.length) throw new Error('NAI 服务返回了空内容');

  const directMime = sniffImageMime(buffer);
  if (directMime) return new Blob([buffer], { type: directMime });

  const raw = new TextDecoder().decode(buffer).trim();
  if (contentType.startsWith('image/')) return new Blob([buffer], { type: contentType.split(';')[0] });
  if (raw.startsWith('{') || raw.startsWith('[')) {
    let payload: any;
    try { payload = JSON.parse(raw); }
    catch { throw new Error(`NAI 返回了 JSON-like 内容但解析失败（Content-Type: ${contentType || '未知'}）：${raw.slice(0, 160)}`); }
    const image = findNaiBase64(payload);
    if (image) {
      try {
        const binary = atob(image.encoded);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        const detectedMime = sniffImageMime(bytes);
        if (!detectedMime) throw new Error('Base64 字段解码成功，但内容不是 PNG、JPEG 或 WebP 图片');
        return new Blob([bytes], { type: detectedMime || image.mimeType || 'image/png' });
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : 'NAI 返回的 Base64 图片无法解码');
      }
    }
    throw new Error(String(errorMessage(payload, 'NAI 服务返回 JSON，但没有可识别的图片数据')).slice(0, 240));
  }

  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    let jszipError = '';
    try {
      const archive = await JSZip.loadAsync(buffer);
      const imageFile = Object.values(archive.files).find(file => !file.dir && /\.(png|webp|jpe?g)$/i.test(file.name));
      if (!imageFile) throw new Error('压缩包中没有 PNG/JPEG/WebP 图片条目');
      const bytes = await imageFile.async('uint8array');
      if (!bytes.length) throw new Error('图片条目解压后为空');
      const extension = imageFile.name.toLowerCase().split('.').pop();
      const mimeType = sniffImageMime(bytes) || (extension === 'webp' ? 'image/webp' : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : 'image/png');
      return new Blob([bytes], { type: mimeType });
    } catch (error) {
      jszipError = error instanceof Error ? error.message : String(error);
    }

    // Some NAI-compatible gateways emit ZIP variants that JSZip cannot read.
    // Retry with the already-installed zip.js implementation before failing.
    let zipReader: InstanceType<typeof ZipReader> | undefined;
    try {
      zipReader = new ZipReader(new Uint8ArrayReader(buffer));
      const entries = await zipReader.getEntries();
      const imageEntry = entries.find(entry => !entry.directory && /\.(png|webp|jpe?g)$/i.test(entry.filename));
      if (!imageEntry) throw new Error('压缩包中没有 PNG/JPEG/WebP 图片条目');
      const bytes = await imageEntry.getData(new Uint8ArrayWriter());
      if (!bytes.length) throw new Error('图片条目解压后为空');
      const extension = imageEntry.filename.toLowerCase().split('.').pop();
      const mimeType = sniffImageMime(bytes) || (extension === 'webp' ? 'image/webp' : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : 'image/png');
      return new Blob([bytes], { type: mimeType });
    } catch (fallbackError) {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`NAI ZIP 解包失败。JSZip：${jszipError.slice(0, 160)}；备用解析器：${fallbackMessage.slice(0, 160)}`);
    } finally {
      await zipReader?.close().catch(() => undefined);
    }
  }

  const preview = raw.replace(/[\\r\\n\\t]+/g, ' ').slice(0, 120);
  throw new Error(`NAI 已返回 HTTP ${response.status} 内容，但不是可识别的图片、ZIP 或图片 JSON（Content-Type: ${contentType || '未知'}，长度: ${buffer.length} bytes）。响应开头：${preview || '二进制数据'}`);
}

export async function generateNaiImage(
  config: NaiImageConfig,
  prompt: string,
  negativePrompt: string,
  options: NaiImageOptions,
  signal?: AbortSignal,
): Promise<Blob> {
  if (!config.apiKey.trim()) throw new Error('请先填写 NovelAI Persistent API Token');
  if (!prompt.trim()) throw new Error('先写下你想生成的画面吧');
  if (options.seed !== undefined && (!Number.isSafeInteger(options.seed) || options.seed < 0 || options.seed > 4294967295)) {
    throw new Error('NAI Seed 必须是 0 到 4294967295 之间的整数');
  }

  const isV5 = config.model.startsWith('nai-diffusion-5');
  const caption = (text: string) => ({
    caption: { base_caption: text, char_captions: [] },
    use_coords: false,
    use_order: true,
  });
  const provider = config.provider || 'official';
  const response = await fetch(normalizeNaiGenerateEndpoint(config.baseUrl || (provider === 'official' ? 'https://image.novelai.net' : ''), provider), {
    method: 'POST',
    headers: buildImageRequestHeaders({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey.trim()}`,
      Accept: 'application/zip',
    }, config.customHeaders),
    body: JSON.stringify({
      input: prompt.trim(),
      model: config.model || 'nai-diffusion-5-full',
      action: 'generate',
      parameters: {
        width: options.width,
        height: options.height,
        scale: options.scale,
        sampler: options.sampler,
        steps: options.steps,
        n_samples: 1,
        seed: options.seed !== undefined ? options.seed : Math.floor(Math.random() * 4294967295),
        negative_prompt: negativePrompt.trim(),
        noise_schedule: 'karras',
        cfg_rescale: 0,
        qualityToggle: true,
        ucPreset: 0,
        params_version: isV5 ? 4 : 3,
        v4_prompt: caption(prompt.trim()),
        v4_negative_prompt: caption(negativePrompt.trim()),
      },
    }),
    signal,
  });

  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    let message = raw;
    try { message = errorMessage(JSON.parse(raw), raw); } catch { /* response is not JSON */ }
    throw new Error(`NAI 生图失败（HTTP ${response.status}）：${message.slice(0, 240)}`);
  }

  return readNaiImageResponse(response);
}


export interface NaiTagSuggestion {
  tag: string;
  count?: number;
  confidence?: number;
}

/** Query NovelAI's own prompt autocomplete endpoint. Suggestions are free and do not generate an image. */
export async function suggestNaiTags(
  config: NaiImageConfig,
  prompt: string,
  signal?: AbortSignal,
): Promise<NaiTagSuggestion[]> {
  if ((config.provider || 'official') !== 'official') throw new Error('官方标签联想仅适用于 NovelAI 官方接口');
  if (!config.apiKey.trim()) throw new Error('请先填写 NovelAI Persistent API Token');
  if (!prompt.trim()) throw new Error('先输入一个标签片段，例如 blue hair');
  const query = new URLSearchParams({
    model: config.model || 'nai-diffusion-5-full',
    prompt: prompt.trim(),
    lang: 'en',
  });
  const response = await fetch(`https://image.novelai.net/ai/generate-image/suggest-tags?${query.toString()}`, {
    method: 'GET',
    headers: buildImageRequestHeaders({
      Authorization: `Bearer ${config.apiKey.trim()}`,
      Accept: 'application/json',
    }, config.customHeaders),
    signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(errorMessage(payload, `NAI 标签建议失败（HTTP ${response.status}）`));
  }
  const candidates = Array.isArray(payload) ? payload : payload?.tags;
  if (!Array.isArray(candidates)) throw new Error('NAI 返回的标签建议格式无法识别');
  return candidates
    .filter((item: any) => item && typeof item.tag === 'string' && item.tag.trim())
    .map((item: any) => ({
      tag: item.tag.trim(),
      ...(typeof item.count === 'number' ? { count: item.count } : {}),
      ...(typeof item.confidence === 'number' ? { confidence: item.confidence } : {}),
    }));
}


export function getNaiQualityTags(model: string, level: 'light' | 'standard'): string[] {
  if (model.startsWith('nai-diffusion-5')) {
    return level === 'light'
      ? ['very aesthetic', 'amazing quality', 'no text']
      : ['very aesthetic', 'masterpiece', 'no text'];
  }
  if (model === 'nai-diffusion-4-5-curated') {
    return ['location', 'masterpiece', 'no text', '-0.8::feet::', 'rating:general'];
  }
  if (model.startsWith('nai-diffusion-4-5')) {
    return ['location', 'very aesthetic', 'masterpiece', 'no text'];
  }
  return ['best quality', 'amazing quality', 'very aesthetic', 'absurdres'];
}
