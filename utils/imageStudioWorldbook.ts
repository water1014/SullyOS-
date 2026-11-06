export interface ImageWorldbookEntry {
  id: string;
  title: string;
  keywords: string[];
  content: string;
  enabled: boolean;
  constant: boolean;
  updatedAt: number;
}

export const IMAGE_WORLDBOOK_STORAGE_KEY = 'sully-image-studio:worldbook:v1';

export function readImageWorldbook(storage?: Pick<Storage, 'getItem'>): ImageWorldbookEntry[] {
  try {
    const raw = (storage || localStorage).getItem(IMAGE_WORLDBOOK_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ImageWorldbookEntry =>
      !!item && typeof item.id === 'string' && typeof item.title === 'string'
      && typeof item.content === 'string' && Array.isArray(item.keywords)
    ).map(item => ({
      id: item.id,
      title: item.title,
      keywords: item.keywords.filter((word: unknown): word is string => typeof word === 'string' && !!word.trim()),
      content: item.content,
      enabled: item.enabled !== false,
      constant: item.constant === true,
      updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
    }));
  } catch {
    return [];
  }
}

export function matchImageWorldbookEntries(
  entries: ImageWorldbookEntry[],
  prompt: string,
): ImageWorldbookEntry[] {
  const source = prompt.toLocaleLowerCase();
  return entries.filter(entry => {
    if (!entry.enabled || !entry.content.trim()) return false;
    if (entry.constant) return true;
    return entry.keywords.some(keyword => keyword.trim()
      && source.includes(keyword.trim().toLocaleLowerCase()));
  });
}

export function formatImageWorldbookContext(entries: ImageWorldbookEntry[]): string {
  return entries.map(entry => `[生图设定：${entry.title}]\n${entry.content.trim()}`).join('\n\n');
}
