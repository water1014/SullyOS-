import JSZip from 'jszip';
import { unzipSync } from 'fflate';
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
    Accept: (config.provider || 'official') === 'thirdparty' ? '*/*' : 'application/zip',
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
    ...((config.provider || 'official') === 'thirdparty' ? { use_new_shared_trial: true } : {}),
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
      // 柏宝绘与智绘姬的同步 NAI ZIP 路线都显式声明 msgpack 传输模式。
      // 第三方兼容站依赖此字段选择 ZIP 响应，缺失时可能走错误的响应编码路径。
      stream: 'msgpack',
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
  throw new Error('ZIP 中没有 PNG/JPEG/WebP 图片条目');
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

/** Last-resort recovery for gateways that preserve local ZIP entries but damage EOCD offsets. */
function readZipU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}
function readZipU32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
async function inflateZipEntry(compressed: Uint8Array, method: number): Promise<Uint8Array> {
  if (method === 0) return compressed.slice();
  if (method !== 8) throw new Error('不支持的 ZIP 压缩方法：' + method);
  if (typeof DecompressionStream === 'undefined') throw new Error('当前 WebView 不支持 ZIP 原始 DEFLATE 解压');
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw' as CompressionFormat));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function extractImageFromLocalZipHeaders(buffer: Uint8Array): Promise<Blob> {
  const localSignature = [0x50, 0x4b, 0x03, 0x04];
  let offset = 0;
  let inspected = 0;
  let lastError = '';
  while (offset <= buffer.length - 30 && inspected < 64) {
    if (localSignature.some((value, index) => buffer[offset + index] !== value)) {
      offset += 1;
      continue;
    }
    inspected += 1;
    const flags = readZipU16(buffer, offset + 6);
    const method = readZipU16(buffer, offset + 8);
    const expectedCrc = readZipU32(buffer, offset + 14);
    const compressedSize = readZipU32(buffer, offset + 18);
    const uncompressedSize = readZipU32(buffer, offset + 22);
    const nameLength = readZipU16(buffer, offset + 26);
    const extraLength = readZipU16(buffer, offset + 28);
    const dataStart = offset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    const hasDataDescriptor = (flags & 0x0008) !== 0;
    if (!hasDataDescriptor && compressedSize !== 0xffffffff && uncompressedSize !== 0xffffffff
      && compressedSize > 0 && uncompressedSize > 0 && uncompressedSize <= 100 * 1024 * 1024
      && dataStart <= buffer.length && dataEnd <= buffer.length) {
      try {
        const bytes = await inflateZipEntry(buffer.subarray(dataStart, dataEnd), method);
        if (bytes.length !== uncompressedSize) throw new Error('ZIP 解压长度校验失败');
        if (crc32(bytes) !== expectedCrc) throw new Error('ZIP CRC32 校验失败');
        const mimeType = sniffImageMime(bytes);
        if (mimeType) return new Blob([bytes], { type: mimeType });
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      offset = dataEnd;
    } else {
      offset += 4;
    }
  }
  throw new Error(lastError || '未找到可独立校验的 ZIP 本地图片条目');
}
function describeNaiZip(buffer: Uint8Array, response: Response): string {
  const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(' ');
  const signature = (offset: number) => offset >= 0 && offset + 4 <= buffer.length && buffer[offset] === 0x50 && buffer[offset + 1] === 0x4b;
  let eocdOffset = -1;
  const searchStart = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= searchStart; offset -= 1) {
    if (buffer[offset] === 0x50 && buffer[offset + 1] === 0x4b && buffer[offset + 2] === 0x05 && buffer[offset + 3] === 0x06) {
      eocdOffset = offset;
      break;
    }
  }
  const flags = buffer.length >= 8 && signature(0) ? buffer[6] | (buffer[7] << 8) : null;
  const method = buffer.length >= 10 && signature(0) ? buffer[8] | (buffer[9] << 8) : null;
  const compressedSize = buffer.length >= 22 && signature(0)
    ? (buffer[18] | (buffer[19] << 8) | (buffer[20] << 16) | (buffer[21] << 24)) >>> 0 : null;
  const localHeader = signature(0) && buffer[2] === 0x03 && buffer[3] === 0x04;
  const descriptorMode = flags !== null && (flags & 0x0008) !== 0;
  const tail = buffer.subarray(Math.max(0, buffer.length - 24));
  const readU16 = (offset: number) => offset >= 0 && offset + 2 <= buffer.length ? buffer[offset] | (buffer[offset + 1] << 8) : null;
  const readU32 = (offset: number) => offset >= 0 && offset + 4 <= buffer.length
    ? (buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 24)) >>> 0 : null;
  const eocdCommentLength = eocdOffset >= 0 ? readU16(eocdOffset + 20) : null;
  const eocdCommentAvailable = eocdOffset >= 0 ? buffer.length - (eocdOffset + 22) : null;
  const centralDirectorySize = eocdOffset >= 0 ? readU32(eocdOffset + 12) : null;
  const centralDirectoryOffset = eocdOffset >= 0 ? readU32(eocdOffset + 16) : null;
  const entryCount = eocdOffset >= 0 ? readU16(eocdOffset + 10) : null;
  const centralCandidate = eocdOffset >= 0 && centralDirectorySize !== null ? eocdOffset - centralDirectorySize : -1;
  const centralHeader = centralCandidate >= 0 && signature(centralCandidate) && buffer[centralCandidate + 2] === 0x01 && buffer[centralCandidate + 3] === 0x02;
  const centralScanHits: number[] = [];
  if (eocdOffset >= 0) {
    for (let offset = Math.max(0, eocdOffset - 0x10000 - 46); offset <= eocdOffset - 46; offset += 1) {
      if (!signature(offset) || buffer[offset + 2] !== 0x01 || buffer[offset + 3] !== 0x02) continue;
      const nameLength = readU16(offset + 28) ?? -1;
      const extraLength = readU16(offset + 30) ?? -1;
      const entryCommentLength = readU16(offset + 32) ?? -1;
      const entryEnd = offset + 46 + nameLength + extraLength + entryCommentLength;
      const gap = eocdOffset - entryEnd;
      const validGap = gap === 0 || (gap >= 6 && signature(entryEnd) && buffer[entryEnd + 2] === 0x05
        && buffer[entryEnd + 3] === 0x05 && readU16(entryEnd + 4) === gap - 6);
      if (nameLength > 0 && extraLength >= 0 && entryCommentLength >= 0 && entryEnd <= eocdOffset && validGap) centralScanHits.push(offset);
    }
  }
  const centralCompressedSize = centralHeader ? readU32(centralCandidate + 20) : null;
  const centralUncompressedSize = centralHeader ? readU32(centralCandidate + 24) : null;
  const centralLocalOffset = centralHeader ? readU32(centralCandidate + 42) : null;
  const centralCrc = centralHeader ? readU32(centralCandidate + 16) : null;
  const commentMismatch = eocdCommentLength !== null && eocdCommentAvailable !== null && eocdCommentLength !== eocdCommentAvailable;
  return [
    '实际读取=' + buffer.length + ' bytes',
    'Content-Length=' + (response.headers.get('Content-Length') || '未提供/不可见') + '（线路声明值；Fetch 自动解码后与实际读取不同不一定异常）',
    'Content-Encoding=' + (response.headers.get('Content-Encoding') || '未提供/identity'),
    'Content-Disposition=' + (response.headers.get('Content-Disposition') || '未提供'),
    'ZIP结束目录=' + (eocdOffset >= 0 ? '存在(offset ' + eocdOffset + ')' : '缺失'),
    'ZIP条目数=' + (entryCount ?? '未知'),
    '中央目录大小/偏移=' + (centralDirectorySize ?? '未知') + '/' + (centralDirectoryOffset ?? '未知'),
    '中央目录记录=' + (centralHeader ? '有效（压缩=' + centralCompressedSize + '，解压=' + centralUncompressedSize + '，本地偏移=' + centralLocalOffset + '，CRC=' + centralCrc?.toString(16) + '）' : '无法定位或签名无效'),
    '中央目录扫描=' + (centralScanHits.length ? centralScanHits.join(',') : '未发现有效单文件记录'),
    'ZIP注释长度声明/实际=' + (eocdCommentLength ?? '未知') + '/' + (eocdCommentAvailable ?? '未知') + (commentMismatch ? '（不一致，疑似截断或字节损坏）' : ''),
    '本地文件头=' + (localHeader ? 'PK0304' : '非PK0304'),
    'flags=' + (flags === null ? '未知' : '0x' + flags.toString(16)),
    '压缩方法=' + (method === null ? '未知' : method),
    '本地头压缩大小=' + (compressedSize === null ? '未知' : compressedSize),
    'data-descriptor模式=' + (descriptorMode ? '是' : '否'),
    '末尾24字节=' + hex(tail),
  ].join('；');
}

async function parseNaiJsonResponse(buffer: Uint8Array): Promise<Blob> {
  const raw = new TextDecoder().decode(buffer);
  let payload: unknown;
  try { payload = JSON.parse(raw); }
  catch { throw new Error('NAI 返回文本，但不是有效 JSON：' + raw.slice(0, 180)); }
  const image = findNaiBase64(payload);
  if (!image) {
    const providerError = responseError(payload, '');
    if (providerError) throw new Error(providerError.slice(0, 240));
    throw new Error('NAI 服务返回 JSON，但没有可识别的图片 Base64 数据');
  }
  return decodeBase64Image(image.encoded);
}

/** Exact ZIP extraction route used by BaiBai: fflate.unzipSync over the untouched response bytes. */
function extractImageWithFflate(buffer: Uint8Array): Blob {
  const files = unzipSync(buffer);
  const names = Object.keys(files).filter(name => !name.endsWith('/'));
  const imageName = names.find(name => /\.(png|jpe?g|webp)$/i.test(name)) || names[0];
  if (!imageName) throw new Error('ZIP 内没有图片文件');
  const bytes = files[imageName];
  if (!bytes?.length) throw new Error('ZIP 图片文件为空');
  const mime = sniffImageMime(bytes);
  if (!mime) throw new Error('ZIP 首个文件不是受支持的图片格式：' + imageName);
  return new Blob([bytes], { type: mime });
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
    // Primary path matches BaiBai exactly: fflate.unzipSync on the original ZIP bytes.
    let fflateError = '';
    try { return extractImageWithFflate(buffer); }
    catch (error) { fflateError = error instanceof Error ? error.message : String(error); }
    let jsZipError = '';
    try { return await extractImageFromJsZip(buffer); }
    catch (error) { jsZipError = error instanceof Error ? error.message : String(error); }
    let zipJsError = '';
    try { return await extractImageFromZipJs(buffer); }
    catch (error) { zipJsError = error instanceof Error ? error.message : String(error); }
    let localEntryError = '';
    try { return await extractImageFromLocalZipHeaders(buffer); }
    catch (error) { localEntryError = error instanceof Error ? error.message : String(error); }
    throw new Error('NAI 返回 ZIP，但 ZIP 结构或图片校验失败：fflate：' + fflateError.slice(0, 100) + '；JSZip：' + jsZipError.slice(0, 100)
      + '；zip.js：' + zipJsError.slice(0, 100) + '；本地文件头恢复：' + localEntryError.slice(0, 100)
      + '。未修改响应元数据。响应诊断：' + describeNaiZip(buffer, response));
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
const NAI_MAX_ATTEMPTS = 4;
const NAI_RETRY_BASE_MS = 2000;
const NAI_MAX_RETRY_WAIT_MS = 60000;

function naiRetryAfterMs(value: string | null): number | null {
  const raw = (value || '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Math.min(Number(raw) * 1000, NAI_MAX_RETRY_WAIT_MS);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.min(Math.max(0, date - Date.now()), NAI_MAX_RETRY_WAIT_MS);
}

function isRetryableNaiNetworkError(error: unknown): boolean {
  const item = error as { name?: string; message?: string } | null;
  const message = String(item?.message || error || '');
  return item?.name === 'TypeError'
    || /unexpected end of stream|connection reset|connection aborted|failed to connect|socket closed|network request failed|networkerror|timed? ?out/i.test(message);
}

function naiRetryDelay(attempt: number, retryAfter: number | null): number {
  const exponential = Math.min(NAI_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), NAI_MAX_RETRY_WAIT_MS);
  const jittered = Math.round(exponential * (0.5 + 0.5 * Math.random()));
  return Math.min(Math.max(jittered, retryAfter || 0), NAI_MAX_RETRY_WAIT_MS);
}

export async function generateNaiImage(config: NaiImageConfig, prompt: string, negativePrompt: string, options: NaiImageOptions, signal?: AbortSignal): Promise<Blob> {
  const request = buildNaiGenerateRequest(config, prompt, negativePrompt, options);
  let lastError: unknown;
  for (let attempt = 1; attempt <= NAI_MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw signal.reason || new DOMException('已取消', 'AbortError');
    try {
      const response = await fetch(request.url, { ...request.init, signal });
      if (!response.ok) {
        const raw = await response.text().catch(() => '');
        let message = raw;
        try { message = responseError(JSON.parse(raw), raw); } catch { /* response is not JSON */ }
        const error = new Error('NAI 生图失败（HTTP ' + response.status + '）：' + message.slice(0, 240)) as Error & { status?: number; retryAfterMs?: number };
        error.status = response.status;
        error.retryAfterMs = naiRetryAfterMs(response.headers.get('Retry-After')) || undefined;
        if (!(response.status === 408 || response.status === 429 || (response.status >= 500 && response.status !== 501))) throw error;
        lastError = error;
        if (attempt === NAI_MAX_ATTEMPTS) throw error;
        const waitMs = naiRetryDelay(attempt, error.retryAfterMs ?? null);
        console.warn('[NAI] upstream transient HTTP failure; retrying', { attempt, max: NAI_MAX_ATTEMPTS - 1, status: response.status, waitMs });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, waitMs);
          signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason || new DOMException('已取消', 'AbortError')); }, { once: true });
        });
        continue;
      }
      return await readNaiImageResponse(response);
    } catch (error) {
      lastError = error;
      if (signal?.aborted || (error as { name?: string })?.name === 'AbortError') throw error;
      if (!isRetryableNaiNetworkError(error) || attempt === NAI_MAX_ATTEMPTS) throw error;
      const waitMs = naiRetryDelay(attempt, null);
      console.warn('[NAI] network transport failed before a complete response; retrying', { attempt, max: NAI_MAX_ATTEMPTS - 1, waitMs, error: String(error) });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, waitMs);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason || new DOMException('已取消', 'AbortError')); }, { once: true });
      });
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'NAI 生图失败'));
}
