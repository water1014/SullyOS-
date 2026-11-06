import { beforeEach, describe, expect, it, vi } from 'vitest';

const { acknowledge, addListener, drain, isAndroid, ingest } = vi.hoisted(() => ({
  acknowledge: vi.fn().mockResolvedValue(undefined),
  addListener: vi.fn(),
  drain: vi.fn(),
  isAndroid: vi.fn(() => true),
  ingest: vi.fn().mockResolvedValue({ charId: 'character-1' }),
}));

vi.mock('./nativeAmsgInbox', () => ({
  ingestNativeAmsgPayload: ingest,
  parseNativeAmsgPayload: vi.fn(() => ({ metadata: { charId: 'character-1' } })),
}));
vi.mock('./unifiedPushPlugin', () => ({
  acknowledgeUnifiedPushMessages: acknowledge,
  addUnifiedPushListener: addListener,
  drainUnifiedPushMessages: drain,
  isUnifiedPushPlatform: isAndroid,
}));

describe('UnifiedPush runtime recovery', () => {
  beforeEach(() => {
    vi.resetModules();
    acknowledge.mockReset();
    acknowledge.mockResolvedValue(undefined);
    addListener.mockReset();
    drain.mockReset();
    ingest.mockReset();
    ingest.mockResolvedValue({ charId: 'character-1' });
    addListener.mockResolvedValue({ remove: vi.fn().mockResolvedValue(undefined) });
    drain.mockResolvedValue({ messages: [] });
  });

  it('does not permanently lock initialization after a missing native bridge', async () => {
    addListener.mockRejectedValueOnce(new Error('Plugin not implemented'));
    const runtime = await import('./unifiedPushRuntime');
    await expect(runtime.initUnifiedPushRuntime()).resolves.toBeUndefined();

    addListener.mockResolvedValue({ remove: vi.fn().mockResolvedValue(undefined) });
    await expect(runtime.initUnifiedPushRuntime()).resolves.toBeUndefined();
    expect(addListener).toHaveBeenCalledTimes(3);
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('drains cold-start messages after listeners are attached', async () => {
    drain.mockResolvedValueOnce({ messages: [{ payload: '{"metadata":{"charId":"c1"}}' }] });
    const runtime = await import('./unifiedPushRuntime');
    await runtime.initUnifiedPushRuntime();
    expect(addListener).toHaveBeenCalledTimes(2);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledWith('{"metadata":{"charId":"c1"}}');
    expect(acknowledge).toHaveBeenCalledWith(0);
  });
});
