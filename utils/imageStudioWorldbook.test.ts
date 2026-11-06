import { describe, expect, it } from 'vitest';
import {
  formatImageWorldbookContext,
  IMAGE_WORLDBOOK_STORAGE_KEY,
  matchImageWorldbookEntries,
  readImageWorldbook,
  type ImageWorldbookEntry,
} from './imageStudioWorldbook';

const entry = (overrides: Partial<ImageWorldbookEntry> = {}): ImageWorldbookEntry => ({
  id: 'book-1', title: '角色服装', keywords: ['白衬衫', 'white shirt'],
  content: '角色始终穿着白衬衫。', enabled: true, constant: false, updatedAt: 1,
  ...overrides,
});

describe('生图专用世界书', () => {
  it('只激活启用且命中关键词的条目，常驻条目不依赖关键词', () => {
    const entries = [
      entry(),
      entry({ id: 'always', title: '画风', constant: true, keywords: [] }),
      entry({ id: 'off', enabled: false, constant: true }),
      entry({ id: 'miss', keywords: ['雪山'] }),
    ];
    expect(matchImageWorldbookEntries(entries, '白衬衫，窗边光线').map(item => item.id)).toEqual(['book-1', 'always']);
  });

  it('生成独立的生图上下文，不改写用户原始提示词', () => {
    const matched = matchImageWorldbookEntries([entry()], '白衬衫');
    expect(formatImageWorldbookContext(matched)).toContain('[生图设定：角色服装]');
    expect(formatImageWorldbookContext(matched)).toContain('角色始终穿着白衬衫。');
  });

  it('读取损坏数据时安全回退为空列表，并过滤无效字段', () => {
    const storage = { getItem: (key: string) => key === IMAGE_WORLDBOOK_STORAGE_KEY ? '[broken' : null };
    expect(readImageWorldbook(storage)).toEqual([]);
    const validStorage = { getItem: () => JSON.stringify([entry(), { id: 2 }, null]) };
    expect(readImageWorldbook(validStorage)).toHaveLength(1);
  });
});
