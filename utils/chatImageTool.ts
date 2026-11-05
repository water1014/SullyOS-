import type { APIConfig } from '../types';
import { DB } from './db';
import { putImageBlob } from './blobRef';
import { generateNaiImage, generateGptImage } from './imageGeneration';

export const CHAT_IMAGE_TOOL_NAME = 'generate_chat_image';

export const CHAT_IMAGE_TOOL = {
  type: 'function',
  function: {
    name: CHAT_IMAGE_TOOL_NAME,
    description: '在当前聊天中生成一张符合刚才对话情境的角色图片。只在用户明确想看图片、角色主动分享图片或情节特别适合用图片表达时调用。scene_description 必须写成具体、可用于绘图的英文视觉描述，不要包含固定角色外貌/画风前缀。',
    parameters: {
      type: 'object',
      properties: {
        scene_description: { type: 'string', description: '当前画面的动态场景描述：动作、表情、服装、地点、时间、光线、构图。尽量使用具体英文标签。' },
        reason: { type: 'string', description: '简短说明为什么此刻分享这张图。' },
      },
      required: ['scene_description'],
      additionalProperties: false,
    },
  },
};

const joinPrompt = (...parts: Array<string | undefined>) => [...new Set(parts.map(p => (p || '').trim()).filter(Boolean))].join(', ');

export async function executeChatImageTool(
  api: APIConfig,
  charId: string,
  charName: string,
  args: { scene_description?: string; reason?: string },
  signal?: AbortSignal,
  reroll?: { positivePrompt?: string; negativePrompt?: string; randomizeSeed?: boolean },
) {
  const cfg = api.chatImage;
  if (!cfg?.enabled) throw new Error('聊天生图尚未启用，请先到设置中开启');
  const scene = String(args.scene_description || '').trim();
  if (!scene) throw new Error('模型没有提供场景描述，无法生成图片');
  let blob: Blob;
  let engine: 'nai' | 'gpt';
  let positive: string;
  let negative: string;
  let model: string;
  if ((cfg.engine || 'nai') === 'nai') {
    engine = 'nai';
    positive = reroll?.positivePrompt || joinPrompt(cfg.naiPositivePrompt, scene);
    negative = reroll?.negativePrompt ?? (cfg.naiNegativePrompt || 'low quality, worst quality, blurry, bad anatomy').trim();
    model = cfg.naiModel || 'nai-diffusion-5-full';
    const seedText = reroll?.randomizeSeed ? '' : (cfg.naiSeed?.trim() || '');
    const seed = seedText ? Number(seedText) : undefined;
    if (seedText && (!Number.isSafeInteger(seed) || seed! < 0 || seed! > 4294967295)) throw new Error('NAI 固定 Seed 必须是 0 到 4294967295 之间的整数');
    blob = await generateNaiImage({
      apiKey: cfg.naiApiKey || '',
      model,
      provider: cfg.naiProvider || 'official',
      baseUrl: cfg.naiBaseUrl || '',
      customHeaders: JSON.stringify(cfg.naiCustomHeaders || {}),
    }, positive, negative, {
      width: Math.round(Math.max(512, Math.min(1536, Number(cfg.naiWidth) || 832)) / 64) * 64,
      height: Math.round(Math.max(512, Math.min(1536, Number(cfg.naiHeight) || 1216)) / 64) * 64,
      steps: Math.max(10, Math.min(50, Number(cfg.naiSteps) || 28)),
      scale: Math.max(1, Math.min(12, Number(cfg.naiScale) || 5)),
      sampler: cfg.naiSampler || 'k_euler_ancestral',
      ...(seed !== undefined ? { seed } : {}),
    }, signal);
  } else {
    engine = 'gpt';
    positive = reroll?.positivePrompt || joinPrompt(cfg.gptPositivePrompt, scene);
    negative = reroll?.negativePrompt ?? (cfg.gptNegativePrompt || '').trim();
    model = cfg.gptModel || 'gpt-image-1';
    blob = await generateGptImage({
      baseUrl: cfg.gptBaseUrl || '',
      apiKey: cfg.gptApiKey || '',
      model,
      customHeaders: JSON.stringify(cfg.gptCustomHeaders || {}),
    }, positive, {
      size: cfg.gptSize || '1024x1024',
      quality: cfg.gptQuality || 'high',
      // Some OpenAI-compatible image providers reject negative_prompt. The normal
      // generator currently forwards it only when configured; users can leave it blank.
      negativePrompt: negative || undefined,
      signal,
    });
  }
  const blobRef = await putImageBlob(blob);
  const messageId = await DB.saveMessage({
    charId,
    role: 'assistant',
    type: 'image',
    content: blobRef,
    metadata: {
      chatImageGeneration: {
        engine, model, positivePrompt: positive, negativePrompt: negative,
        sceneDescription: scene, reason: args.reason || '', createdAt: Date.now(),
        naiSettings: engine === 'nai' ? {
          width: cfg.naiWidth || 832, height: cfg.naiHeight || 1216,
          steps: cfg.naiSteps || 28, scale: cfg.naiScale || 5,
          sampler: cfg.naiSampler || 'k_euler_ancestral',
          seed: cfg.naiSeed || '',
        } : undefined,
      },
    },
  } as any);
  return { messageId, blobRef, engine, model, sceneDescription: scene };
}
