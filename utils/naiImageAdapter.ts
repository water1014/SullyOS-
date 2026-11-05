import JSZip from 'jszip';
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js';
import { normalizeApiHeaders } from './apiConfigNormalize';

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
type NaiRequest = { url: string; init: RequestInit };

export function normalizeNaiGenerateEndpoint(baseUrl: string, provider: 'official' | 'thirdparty' = 'official'): string {
  const raw = baseUrl.trim() || (provider === 'official' ? 'https://image.novelai.net' : '');
  if (!raw) throw new Error('请填写 NAI 第三方 API Base URL');
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { throw new Error('NAI API Base URL 必须是完整的 http:// 或 https:// 地址'); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('NAI API Base URL 只支持 HTTP 或 HTTPS 地址');
  const basePath = parsed.pathname.replace(/^\/+|\/+$/g, '');
  const hasGenerationPath = basePath === 'ai/generate-image' || basePath.endsWith('/ai/generate-image');
  parsed.pathname = hasGenerationPath ? '/' + basePath : basePath ? '/' + basePath + '/ai/generate-image' : '/ai/generate-image';
  return parsed.toString().replace(/\/$/, '');
}

function makeNaiHeaders(config: NaiImageConfig): Headers {
  const headers = new Headers({
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + config.apiKey.trim(),
    Accept: 'application/zip',
  });
  const raw = config.customHeaders || '';
  if (!raw.trim()) return headers;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('额外请求头必须是合法 JSON 对象'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('额外请求头必须是 JSON 对象，例如 {"x-api-key":"你的密钥"}');
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string' || !name.trim() || /[\r\n]/.test(name + value)) throw new Error('额外请求头的名称和值必须是有效字符串');
  }
  for (const [name, value] of Object.entries(normalizeApiHeaders(parsed))) headers.set(name, value);
  return headers;
}

/** Keep the synchronous NovelAI-native request contract used by the original working build. */
export function buildNaiGenerateRequest(config: NaiImageConfig, prompt: string, negativePrompt: string, options: NaiImageOptions): NaiRequest {
  if (!config.apiKey.trim()) throw new Error('请先填写 NovelAI Persistent API Token');
  if (!prompt.trim()) throw new Error('先写下你想生成的画面吧');
  if (options.seed !== undefined && (!Number.isSafeInteger(options.seed) || options.seed < 0 || options.seed > 4294967295)) {
    throw new Error('NAI Seed 必须是 0 到 4294967295 之间的整数');
  }
  const model = config.model || 'nai-diffusion-5-full';
  const isV5 = model.startsWith('nai-diffusion-5');
  const caption = (text: string) => ({ caption: { base_caption: text, char_captions: [] }, use_coords: false, use_order: true });
  const provider = config.provider || 'official';
  const body = {
    input: prompt.trim(),
    model,
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
  };
  return {
    url: normalizeNaiGenerateEndpoint(config.baseUrl || (provider === 'official' ? 'https://image.novelai.net' : ''), provider),
    init: { method: 'POST', headers: makeNaiHeaders(config), body: JSON.stringify(body) },
  };
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
  const mimeType = typeof object.mime_type === 'string' ? object.mime_type : typeof object.mimeType === 'string' ? object.mimeType : undefined;
  for (const key of ['image', 'image_base64', 'base64', 'b64_json', 'output', 'result']) {
    const candidate = object[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      const match = candidate.trim().match(/^(?:data:(image\/[a-z0-9.+-]+);base64,)?([a-z0-9+/=_\-\s]+)$/i);
      if (match && match[2].replace(/\s/g, '').length) return { encoded: match[2].replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/'), mimeType: match[1] || mimeType };
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
function decodeBase64Image(encoded: string): Blob {
  const normalized = encoded.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const mimeType = sniffImageMime(bytes);
  if (!mimeType) throw new Error('Base64 字段解码成功，但内容不是有效的 PNG/JPEG/WebP 图片');
  return new Blob([bytes], { type: mimeType });
}
async function extractImageFromJsZip(buffer: Uint8Array): Promise<Blob> {
  const archive = await JSZip.loadAsync(buffer);
  for (const file of Object.values(archive.files)) {
    if (file.dir) continue;
    const bytes = await file.async('uint8array');
    const mimeType = sniffImageMime(bytes);
    if (mimeType) return new Blob([bytes], { type: mimeType });
  }
  throw new Error('ZIP 中没有有效的 PNG/JPEG/WebP 图片条目');
}
async function extractImageFromZipJs(buffer: Uint8Array): Promise<Blob> {
  const reader = new ZipReader(new Uint8ArrayReader(buffer));
  try {
    const entries = await reader.getEntries();
    for (const entry of entries) {
      if (entry.directory) continue;
      const bytes = await entry.getData(new Uint8ArrayWriter());
      const mimeType = sniffImageMime(bytes);
      if (mimeType) return new Blob([bytes], { type: mimeType });
    }
    throw new Error('ZIP 中没有有效的 PNG/JPEG/WebP 图片条目');
  } finally {
    await reader.close().catch(() => undefined);
  }
}
function zipDiagnostics(buffer: Uint8Array, response: Response): string {
  let eocd = -1;
  const start = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= start; i -= 1) {
    if (buffer[i] === 0x50 && buffer[i + 1] === 0x4b && buffer[i + 2] === 0x05 && buffer[i + 3] === 0x06) { eocd = i; break; }
  }
  const tail = Array.from(buffer.subarray(Math.max(0, buffer.length - 24)), byte => byte.toString(16).padStart(2, '0')).join(' ');
  return ['实际读取=' + buffer.length + ' bytes', 'Content-Length=' + (response.headers.get('content-length') || '未提供'),
    'Content-Encoding=' + (response.headers.get('content-encoding') || '未提供/identity'),
    'Content-Disposition=' + (response.headers.get('content-disposition') || '未提供'),
    'ZIP结束目录=' + (eocd >= 0 ? '存在(offset ' + eocd + ')' : '缺失'), '末尾24字节=' + tail].join('；');
}
async function parseNaiJsonResponse(buffer: Uint8Array): Promise<Blob> {
  const raw = new TextDecoder().decode(buffer);
  let payload: unknown;
  try { payload = JSON.parse(raw); }
  catch { throw new Error('NAI 返回文本，但不是有效 JSON：' + raw.slice(0, 180)); }
  const image = findNaiBase64(payload);
  if (!image) throw new Error('NAI 服务返回 JSON，但没有可识别的图片 Base64 数据');
  return decodeBase64Image(image.encoded);
}

/** Read once, validate actual image bytes, and never rewrite ZIP offsets or CRC metadata. */
export async function readNaiImageResponse(response: Response): Promise<Blob> {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (!buffer.length) throw new Error('NAI 服务返回了空内容');
  const directMime = sniffImageMime(buffer);
  if (directMime) return new Blob([buffer], { type: directMime });
  const prefix = new TextDecoder().decode(buffer.subarray(0, Math.min(buffer.length, 32))).trimStart();
  if (contentType.includes('json') || contentType.startsWith('text/') || prefix.startsWith('{') || prefix.startsWith('[')) return parseNaiJsonResponse(buffer);
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    let jsZipError = '';
    try { return await extractImageFromJsZip(buffer); }
    catch (error) { jsZipError = error instanceof Error ? error.message : String(error); }
    let zipJsError = '';
    try { return await extractImageFromZipJs(buffer); }
    catch (error) { zipJsError = error instanceof Error ? error.message : String(error); }
    throw new Error('NAI 返回 ZIP，但 ZIP 结构或图片校验失败。JSZip：' + jsZipError.slice(0, 120)
      + '；zip.js：' + zipJsError.slice(0, 120) + '。响应诊断：' + zipDiagnostics(buffer, response));
  }
  const preview = new TextDecoder().decode(buffer.subarray(0, Math.min(buffer.length, 160))).replace(/[^\x20-\x7e\u4e00-\u9fff]/g, '.');
  throw new Error('NAI 返回了无法识别的数据（Content-Type: ' + (contentType || '未知') + '，长度: ' + buffer.length + ' bytes）。响应开头：' + (preview || '二进制数据'));
}
function responseError(payload: unknown, fallback: string): string {
  const object = payload && typeof payload === 'object' ? payload as Record<string, any> : {};
  const error = object.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message;
  return String(object.message || object.detail || fallback);
}
export async function generateNaiImage(config: NaiImageConfig, prompt: string, negativePrompt: string, options: NaiImageOptions, signal?: AbortSignal): Promise<Blob> {
  const request = buildNaiGenerateRequest(config, prompt, negativePrompt, options);
  const response = await fetch(request.url, { ...request.init, signal });
  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    let message = raw;
    try { message = responseError(JSON.parse(raw), raw); } catch { /* response is not JSON */ }
    throw new Error('NAI 生图失败（HTTP ' + response.status + '）：' + message.slice(0, 240));
  }
  return readNaiImageResponse(response);
}
