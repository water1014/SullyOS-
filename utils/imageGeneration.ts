import JSZip from 'jszip';
import { unzipSync } from 'fflate';

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

function describeNaiZip(buffer: Uint8Array, response: Response): string {
  const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(' ');
  const signature = (offset: number) => offset >= 0 && offset + 4 <= buffer.length
    && buffer[offset] === 0x50 && buffer[offset + 1] === 0x4b;
  let eocdOffset = -1;
  const searchStart = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= searchStart; offset -= 1) {
    if (buffer[offset] === 0x50 && buffer[offset + 1] === 0x4b
      && buffer[offset + 2] === 0x05 && buffer[offset + 3] === 0x06) {
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
  const contentLength = response.headers.get('Content-Length');
  const contentEncoding = response.headers.get('Content-Encoding');
  const contentDisposition = response.headers.get('Content-Disposition');
  const readU16 = (offset: number) => offset >= 0 && offset + 2 <= buffer.length
    ? buffer[offset] | (buffer[offset + 1] << 8) : null;
  const readU32 = (offset: number) => offset >= 0 && offset + 4 <= buffer.length
    ? (buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 24)) >>> 0 : null;
  const eocdCommentLength = eocdOffset >= 0 ? readU16(eocdOffset + 20) : null;
  const eocdCommentAvailable = eocdOffset >= 0 ? buffer.length - (eocdOffset + 22) : null;
  const centralDirectorySize = eocdOffset >= 0 ? readU32(eocdOffset + 12) : null;
  const centralDirectoryOffset = eocdOffset >= 0 ? readU32(eocdOffset + 16) : null;
  const entryCount = eocdOffset >= 0 ? readU16(eocdOffset + 10) : null;
  const centralCandidate = eocdOffset >= 0 && centralDirectorySize !== null
    ? eocdOffset - centralDirectorySize : -1;
  const centralHeader = centralCandidate >= 0 && signature(centralCandidate)
    && buffer[centralCandidate + 2] === 0x01 && buffer[centralCandidate + 3] === 0x02;
  const centralScanHits: number[] = [];
  if (eocdOffset >= 0) {
    for (let offset = Math.max(0, eocdOffset - 0x10000 - 46); offset <= eocdOffset - 46; offset += 1) {
      if (!signature(offset) || buffer[offset + 2] !== 0x01 || buffer[offset + 3] !== 0x02) continue;
      const nameLength = readU16(offset + 28) ?? -1;
      const extraLength = readU16(offset + 30) ?? -1;
      const entryCommentLength = readU16(offset + 32) ?? -1;
      const entryEnd = offset + 46 + nameLength + extraLength + entryCommentLength;
      const gap = eocdOffset - entryEnd;
      const validGap = gap === 0 || (gap >= 6 && signature(entryEnd)
        && buffer[entryEnd + 2] === 0x05 && buffer[entryEnd + 3] === 0x05
        && readU16(entryEnd + 4) === gap - 6);
      if (nameLength > 0 && extraLength >= 0 && entryCommentLength >= 0
        && entryEnd <= eocdOffset && validGap) centralScanHits.push(offset);
    }
  }
  const centralCompressedSize = centralHeader ? readU32(centralCandidate + 20) : null;
  const centralUncompressedSize = centralHeader ? readU32(centralCandidate + 24) : null;
  const centralLocalOffset = centralHeader ? readU32(centralCandidate + 42) : null;
  const centralCrc = centralHeader ? readU32(centralCandidate + 16) : null;
  const commentMismatch = eocdCommentLength !== null && eocdCommentAvailable !== null
    && eocdCommentLength !== eocdCommentAvailable;
  return [
    `实际读取=${buffer.length} bytes`,
    `Content-Length=${contentLength || '未提供/不可见'}（线路声明值；Fetch 自动解码后与实际读取不同不一定异常）`,
    `Content-Encoding=${contentEncoding || '未提供/identity'}`,
    `Content-Disposition=${contentDisposition || '未提供'}`,
    `ZIP结束目录=${eocdOffset >= 0 ? `存在(offset ${eocdOffset})` : '缺失'}`,
    `ZIP条目数=${entryCount ?? '未知'}`,
    `中央目录大小/偏移=${centralDirectorySize ?? '未知'}/${centralDirectoryOffset ?? '未知'}`,
    `中央目录记录=${centralHeader ? `有效（压缩=${centralCompressedSize}，解压=${centralUncompressedSize}，本地偏移=${centralLocalOffset}，CRC=${centralCrc?.toString(16)}）` : '无法定位或签名无效'}`,
    `中央目录扫描=${centralScanHits.length ? centralScanHits.map(offset => offset.toString()).join(',') : '未发现有效单文件记录'}`,
    `ZIP注释长度声明/实际=${eocdCommentLength ?? '未知'}/${eocdCommentAvailable ?? '未知'}${commentMismatch ? '（不一致，疑似截断或字节损坏）' : ''}`,
    `本地文件头=${localHeader ? 'PK0304' : '非PK0304'}`,
    `flags=${flags === null ? '未知' : `0x${flags.toString(16)}`}`,
    `压缩方法=${method === null ? '未知' : method}`,
    `本地头压缩大小=${compressedSize === null ? '未知' : compressedSize}`,
    `data-descriptor模式=${descriptorMode ? '是' : '否'}`,
    `末尾24字节=${hex(tail)}`,
  ].join('；');
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

function calculateNaiCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function repairSingleEntryNaiZipMetadata(source: Uint8Array): Uint8Array | null {
  const readU16 = (offset: number) => offset >= 0 && offset + 2 <= source.length
    ? source[offset] | (source[offset + 1] << 8) : -1;
  const readU32 = (offset: number) => offset >= 0 && offset + 4 <= source.length
    ? (source[offset] | (source[offset + 1] << 8) | (source[offset + 2] << 16) | (source[offset + 3] << 24)) >>> 0 : -1;
  const writeU16 = (target: Uint8Array, offset: number, value: number) => {
    target[offset] = value & 0xff;
    target[offset + 1] = (value >>> 8) & 0xff;
  };
  const writeU32 = (target: Uint8Array, offset: number, value: number) => {
    target[offset] = value & 0xff;
    target[offset + 1] = (value >>> 8) & 0xff;
    target[offset + 2] = (value >>> 16) & 0xff;
    target[offset + 3] = (value >>> 24) & 0xff;
  };
  const hasSignature = (offset: number, a: number, b: number, c: number, d: number) =>
    offset >= 0 && offset + 4 <= source.length
    && source[offset] === a && source[offset + 1] === b
    && source[offset + 2] === c && source[offset + 3] === d;

  let eocd = -1;
  for (let offset = source.length - 22; offset >= Math.max(0, source.length - 22 - 0xffff); offset -= 1) {
    if (hasSignature(offset, 0x50, 0x4b, 0x05, 0x06)) { eocd = offset; break; }
  }
  if (eocd < 0 || readU16(eocd + 4) !== 0 || readU16(eocd + 6) !== 0
    || readU16(eocd + 8) !== 1 || readU16(eocd + 10) !== 1) return null;
  if (!hasSignature(0, 0x50, 0x4b, 0x03, 0x04)) return null;

  const localFlags = readU16(6);
  const localMethod = readU16(8);
  const localNameLength = readU16(26);
  const localExtraLength = readU16(28);
  if (localFlags < 0 || localMethod < 0 || localNameLength <= 0 || localExtraLength < 0) return null;
  const dataStart = 30 + localNameLength + localExtraLength;
  if (dataStart >= eocd) return null;

  // Some ZIP writers place a PK0505 central-directory digital-signature record
  // between the single central-file record and EOCD. eocd - declaredCentralSize
  // then points at PK0505, not PK0102. Scan the bounded tail and validate the
  // complete record rather than assuming the central directory touches EOCD.
  const scanStart = Math.max(dataStart, eocd - 0x10000 - 46);
  const candidates: Array<{ offset: number; size: number; gap: number; flags: number; method: number; nameLength: number; uncompressedSize: number }> = [];
  for (let offset = scanStart; offset <= eocd - 46; offset += 1) {
    if (!hasSignature(offset, 0x50, 0x4b, 0x01, 0x02)) continue;
    const nameLength = readU16(offset + 28);
    const extraLength = readU16(offset + 30);
    const commentLength = readU16(offset + 32);
    const entrySize = 46 + nameLength + extraLength + commentLength;
    const entryEnd = offset + entrySize;
    if (nameLength <= 0 || extraLength < 0 || commentLength < 0 || entryEnd > eocd) continue;
    const gap = eocd - entryEnd;
    const validGap = gap === 0 || (
      gap >= 6 && hasSignature(entryEnd, 0x50, 0x4b, 0x05, 0x05)
      && readU16(entryEnd + 4) === gap - 6
    );
    if (!validGap) continue;

    const flags = readU16(offset + 8);
    const method = readU16(offset + 10);
    const uncompressedSize = readU32(offset + 24);
    const diskStart = readU16(offset + 34);
    if (flags !== localFlags || method !== localMethod || diskStart !== 0
      || (flags & 0x0009) !== 0 || (method !== 0 && method !== 8)
      || uncompressedSize <= 0 || uncompressedSize > 100 * 1024 * 1024
      || nameLength !== localNameLength) continue;

    let sameName = true;
    for (let index = 0; index < nameLength; index += 1) {
      if (source[30 + index] !== source[offset + 46 + index]) { sameName = false; break; }
    }
    if (!sameName || dataStart >= offset) continue;
    candidates.push({ offset, size: entrySize, gap, flags, method, nameLength, uncompressedSize });
  }

  // Recovery is intentionally limited to one unambiguous, unencrypted image entry.
  if (candidates.length !== 1) return null;
  const central = candidates[0];
  const inferredCompressedSize = central.offset - dataStart;
  if (inferredCompressedSize <= 0 || inferredCompressedSize > 0xffffffff) return null;

  // Normalize the optional central-directory digital-signature record away.
  // JSZip and fflate do not consistently accept this record between the
  // central directory and EOCD, even when its length is valid.
  let repaired: Uint8Array;
  let repairedEocd = eocd;
  if (central.gap > 0) {
    const entryEnd = central.offset + central.size;
    repairedEocd = eocd - central.gap;
    repaired = new Uint8Array(source.length - central.gap);
    repaired.set(source.subarray(0, entryEnd), 0);
    repaired.set(source.subarray(eocd), repairedEocd);
  } else {
    repaired = source.slice();
  }
  const crc = readU32(central.offset + 16);
  writeU32(repaired, 14, crc);
  writeU32(repaired, 18, inferredCompressedSize);
  writeU32(repaired, 22, central.uncompressedSize);
  writeU32(repaired, central.offset + 20, inferredCompressedSize);
  writeU32(repaired, central.offset + 42, 0);
  writeU32(repaired, repairedEocd + 12, central.size);
  writeU32(repaired, repairedEocd + 16, central.offset);
  writeU16(repaired, repairedEocd + 20, Math.max(0, repaired.length - repairedEocd - 22));
  return repaired;
}

async function readNaiImageResponse(response: Response): Promise<Blob> {
  const contentType = (response.headers.get('Content-Type') || '').toLowerCase();
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (!buffer.length) throw new Error('NAI 服务返回了空内容');

  // Gateways sometimes label raw PNG/JPEG/WebP bytes as application/octet-stream.
  const directMime = sniffImageMime(buffer);
  if (directMime) return new Blob([buffer], { type: directMime });

  const rawPrefix = new TextDecoder().decode(buffer.subarray(0, Math.min(buffer.length, 512))).trimStart();
  const looksLikeJson = contentType.includes('json') || rawPrefix.startsWith('{') || rawPrefix.startsWith('[');
  if (looksLikeJson || contentType.startsWith('text/')) {
    let payload: any;
    try {
      payload = JSON.parse(new TextDecoder().decode(buffer));
    } catch {
      throw new Error(`NAI 返回了文本但不是有效 JSON（Content-Type: ${contentType || '未知'}，长度: ${buffer.length} bytes）。请检查第三方接口响应。`);
    }
    const image = findNaiBase64(payload);
    if (image) {
      try {
        const binary = atob(image.encoded);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        const mimeType = sniffImageMime(bytes);
        if (!mimeType) throw new Error('Base64 字段解码成功，但内容不是 PNG、JPEG 或 WebP 图片');
        return new Blob([bytes], { type: mimeType });
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : 'NAI 返回的 Base64 图片无法解码');
      }
    }
    throw new Error(String(errorMessage(payload, 'NAI 服务返回 JSON，但没有可识别的图片数据或 Base64 字段')).slice(0, 240));
  }

  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    let originalError = '';
    const repaired = repairSingleEntryNaiZipMetadata(buffer);
    const candidates = repaired ? [buffer, repaired] : [buffer];
    for (const candidate of candidates) {
      try {
        const archive = await JSZip.loadAsync(candidate, { checkCRC32: true });
        const imageFile = Object.values(archive.files).find(file =>
          !file.dir && /\.(png|webp|jpe?g)$/i.test(file.name),
        );
        if (!imageFile) throw new Error('ZIP 中没有 PNG/JPEG/WebP 图片条目');
        const bytes = await imageFile.async('uint8array');
        const mimeType = sniffImageMime(bytes);
        if (!mimeType) throw new Error('ZIP 图片条目解压后不是有效的 PNG/JPEG/WebP 数据');
        return new Blob([bytes], { type: mimeType });
      } catch (error) {
        if (!originalError) originalError = error instanceof Error ? error.message : String(error);
      }

      // 柏宝绘同样使用 fflate。作为第二套独立解码器，兼容 JSZip 不接受的
      // ZIP 变体；同时校验本地头 CRC，避免把损坏的压缩数据误报为成功。
      try {
        const files = unzipSync(candidate);
        const imageName = Object.keys(files).find(name => /\.(png|webp|jpe?g)$/i.test(name));
        if (!imageName) throw new Error('ZIP 中没有 PNG/JPEG/WebP 图片条目');
        const bytes = files[imageName];
        const expectedCrc = (candidate[14] | (candidate[15] << 8)
          | (candidate[16] << 16) | (candidate[17] << 24)) >>> 0;
        if (calculateNaiCrc32(bytes) !== expectedCrc) throw new Error('ZIP 图片 CRC 校验失败，响应数据可能已损坏');
        const mimeType = sniffImageMime(bytes);
        if (!mimeType) throw new Error('ZIP 图片条目解压后不是有效的 PNG/JPEG/WebP 数据');
        return new Blob([bytes], { type: mimeType });
      } catch (error) {
        if (!originalError) originalError = error instanceof Error ? error.message : String(error);
      }
    }
    throw new Error(`NAI 返回 ZIP，但解包失败：${originalError.slice(0, 180)}。已尝试安全修复单文件 ZIP 元数据；响应诊断：${describeNaiZip(buffer, response)}`);
  }

  const prefixHex = Array.from(buffer.subarray(0, 16), byte => byte.toString(16).padStart(2, '0')).join(' ');
  const safePrefix = new TextDecoder().decode(buffer.subarray(0, 160)).replace(/[^\x20-\x7e\u4e00-\u9fff]/g, '.');
  throw new Error(`NAI 返回了无法识别的数据（Content-Type: ${contentType || '未知'}，长度: ${buffer.length} bytes，文件头: ${prefixHex}，文本预览: ${safePrefix || '无'}）。请核对第三方接口的响应协议。`);
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
      Accept: provider === 'thirdparty' ? '*/*' : 'application/zip',
    }, config.customHeaders),
    body: JSON.stringify({
      input: prompt.trim(),
      model: config.model || 'nai-diffusion-5-full',
      action: 'generate',
      // Match the third-party NAI client request shape used by 智绘姬 / 柏宝绘.
      ...(provider === 'thirdparty' ? { use_new_shared_trial: true } : {}),
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
        // Match the NAI-compatible request shape used by 柏宝绘 and other
        // third-party gateways: the sync ZIP endpoint expects the msgpack
        // stream hint in parameters even though the response is still a ZIP.
        stream: 'msgpack',
        ucPreset: 3,
        params_version: isV5 ? 4 : 3,
        dynamic_thresholding: false,
        controlnet_strength: 1,
        legacy: false,
        legacy_uc: false,
        add_original_image: true,
        legacy_v3_extend: false,
        reference_strength_multiple: [],
        normalize_reference_strength_multiple: true,
        use_coords: false,
        ...(isV5 || config.model.startsWith('nai-diffusion-4-5') || config.model.startsWith('nai-diffusion-4-')
          ? { reference_image_multiple_cached: [], characterPrompts: [] }
          : {}),
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
