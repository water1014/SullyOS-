import type { ImageEngine } from './imageGeneration';

const ITEMS_KEY = 'sully-image-studio:items:v1';

export interface ChatStudioImageInput {
  messageId: number;
  blobRef: string;
  engine: ImageEngine;
  model: string;
  positivePrompt: string;
  negativePrompt: string;
  createdAt: number;
  mimeType: string;
  naiSettings?: { size: string; steps: number; scale: number; sampler: string; seed?: number };
}

/**
 * Add/update a chat-generated image in Image Studio's existing index.
 * The raw blob id is shared with chat/gallery storage, so no second binary copy is made.
 */
export async function upsertChatImageStudioItem(input: ChatStudioImageInput): Promise<void> {
  if (typeof localStorage === 'undefined') throw new Error('Image Studio index is unavailable');
  const commit = () => {
    let current: any[] = [];
    try {
      const parsed = JSON.parse(localStorage.getItem(ITEMS_KEY) || '[]');
      if (Array.isArray(parsed)) current = parsed;
    } catch { current = []; }
    const id = `chat_${input.messageId}`;
    const item = {
      id,
      blobId: input.blobRef.replace(/^blobref:/, ''),
      engine: input.engine,
      prompt: input.positivePrompt,
      negativePrompt: input.negativePrompt,
      model: input.model,
      createdAt: input.createdAt,
      mimeType: input.mimeType || 'image/png',
      ...(input.naiSettings ? { naiSettings: input.naiSettings } : {}),
      sourceMessageId: input.messageId,
      category: '其他',
    };
    const next = [item, ...current.filter(existing => existing?.id !== id)];
    localStorage.setItem(ITEMS_KEY, JSON.stringify(next));
  };
  if (typeof navigator !== 'undefined' && navigator.locks) {
    await navigator.locks.request('sully-image-studio:items-index', { mode: 'exclusive' }, commit);
  } else {
    commit();
  }
}
