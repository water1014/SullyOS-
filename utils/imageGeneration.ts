import JSZip from 'jszip';

export type ImageEngine = 'gpt' | 'nai';

export interface GptImageConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface NaiImageConfig {
  apiKey: string;
  model: string;
  provider?: 'official' | 'thirdparty';
  baseUrl?: string;
}

export interface NaiImageOptions {
  width: number;
  height: number;
  steps: number;
  scale: number;
  sampler: string;
  seed?: number;
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
  options: { size: string; quality: string; signal?: AbortSignal },
): Promise<Blob> {
  if (!config.apiKey.trim()) throw new Error('请先填写 GPT 生图 API Key');
  if (!prompt.trim()) throw new Error('请写下希望如何修改参考图');
  if (!image.type.startsWith('image/')) throw new Error('参考文件必须是图片');
  if (image.size > 20 * 1024 * 1024) throw new Error('参考图片不能超过 20 MB');

  const imageUrl = await blobToDataUrl(image);
  const response = await fetch(normalizeOpenAIImageEditsEndpoint(config.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey.trim()}`,
    },
    body: JSON.stringify({
      model: config.model || 'gpt-image-2.5-flare',
      images: [{ image_url: imageUrl }],
      prompt: prompt.trim(),
      size: options.size,
      quality: options.quality,
      n: 1,
      output_format: 'png',
    }),
    signal: options.signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(errorMessage(payload, `GPT 图片编辑失败（HTTP ${response.status}）`));
  const encoded = payload?.data?.[0]?.b64_json;
  if (typeof encoded !== 'string' || !encoded) {
    throw new Error('GPT API 没有返回编辑后的图片数据，请确认服务支持 Images Edits 接口。');
  }
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}

export async function generateGptImage(
  config: GptImageConfig,
  prompt: string,
  options: { size: string; quality: string; signal?: AbortSignal },
): Promise<Blob> {
  if (!config.apiKey.trim()) throw new Error('请先填写 GPT 生图 API Key');
  if (!prompt.trim()) throw new Error('先写下你想生成的画面吧');
  const response = await fetch(normalizeOpenAIImagesEndpoint(config.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey.trim()}`,
    },
    body: JSON.stringify({
      model: config.model || 'gpt-image-2.5-flare',
      prompt: prompt.trim(),
      size: options.size,
      quality: options.quality,
      n: 1,
      output_format: 'png',
    }),
    signal: options.signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(errorMessage(payload, `GPT 生图失败（HTTP ${response.status}）`));
  const encoded = payload?.data?.[0]?.b64_json;
  if (typeof encoded !== 'string' || !encoded) {
    throw new Error('GPT API 没有返回图片数据。请确认接口支持 GPT Image 图片生成，而不只是聊天补全。');
  }
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}

export function normalizeNaiGenerateEndpoint(baseUrl: string, provider: 'official' | 'thirdparty' = 'official'): string {
  const clean = (baseUrl.trim() || (provider === 'official' ? 'https://image.novelai.net' : '')).replace(/\\/+$/, '');
  if (!clean) throw new Error('请填写 NAI 第三方 API Base URL');
  return clean.endsWith('/ai/generate-image') ? clean : `${clean}/ai/generate-image`;
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

  const isV5 = config.model.startsWith('nai-diffusion-5');
  const caption = (text: string) => ({
    caption: { base_caption: text, char_captions: [] },
    use_coords: false,
    use_order: true,
  });
  const provider = config.provider || 'official';
  const response = await fetch(normalizeNaiGenerateEndpoint(config.baseUrl || (provider === 'official' ? 'https://image.novelai.net' : ''), provider), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey.trim()}`,
      Accept: 'application/zip',
    },
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
        seed: options.seed && options.seed > 0 ? options.seed : Math.floor(Math.random() * 4294967295),
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

  const archive = await JSZip.loadAsync(await response.arrayBuffer());
  const imageFile = Object.values(archive.files).find(file =>
    !file.dir && /\.(png|webp|jpe?g)$/i.test(file.name),
  );
  if (!imageFile) throw new Error('NAI 返回成功，但压缩包中没有找到图片文件');
  const bytes = await imageFile.async('uint8array');
  const extension = imageFile.name.toLowerCase().split('.').pop();
  const mimeType = extension === 'webp' ? 'image/webp' : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : 'image/png';
  return new Blob([bytes], { type: mimeType });
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
    headers: {
      Authorization: `Bearer ${config.apiKey.trim()}`,
      Accept: 'application/json',
    },
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
