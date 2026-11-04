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

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取参考图片'));
    reader.onerror = () => reject(new Error('读取参考图片失败'));
    reader.readAsDataURL(blob);
  });
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
  const response = await fetch('https://image.novelai.net/ai/generate-image', {
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

  const archive = await JSZip.loadAsync(await response.blob());
  const imageFile = Object.values(archive.files).find(file =>
    !file.dir && /\.(png|webp|jpe?g)$/i.test(file.name),
  );
  if (!imageFile) throw new Error('NAI 返回成功，但压缩包中没有找到图片文件');
  const bytes = await imageFile.async('uint8array');
  const extension = imageFile.name.toLowerCase().split('.').pop();
  const mimeType = extension === 'webp' ? 'image/webp' : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : 'image/png';
  return new Blob([bytes], { type: mimeType });
}
