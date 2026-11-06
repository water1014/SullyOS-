import { beforeEach, describe, expect, it, vi } from 'vitest';

const { acknowledge, addListener, drain, isAndroid, ingest, listeners } = vi.hoisted(() => ({
  listeners: {} as Record<string, (event: any) => void>,
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
    Object.keys(listeners).forEach((key) => delete listeners[key]);
    addListener.mockImplementation(async (eventName, listener) => {
      listeners[eventName] = listener;
      return { remove: vi.fn().mockResolvedValue(undefined) };
    });
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
    drain.mockResolvedValueOnce({ messages: [{ payload: '{"metadata":{"charId":"c1"}}', receivedAt: 123 }] });
    const runtime = await import('./unifiedPushRuntime');
    await runtime.initUnifiedPushRuntime();
    expect(addListener).toHaveBeenCalledTimes(2);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledWith('{"metadata":{"charId":"c1"}}');
    expect(acknowledge).toHaveBeenCalledWith(123);
  });
  it('does not acknowledge messages when inbox ingestion fails', async () => {
    drain.mockResolvedValueOnce({ messages: [{ payload: '{"metadata":{"charId":"c1"}}', receivedAt: 123 }] });
    ingest.mockRejectedValueOnce(new Error('IndexedDB write failed'));
    const runtime = await import('./unifiedPushRuntime');
    await runtime.initUnifiedPushRuntime();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('acknowledges live push events only after inbox ingestion', async () => {
    const runtime = await import('./unifiedPushRuntime');
    await runtime.initUnifiedPushRuntime();
    await listeners.pushReceived({ payload: '{"metadata":{"charId":"c1"}}', receivedAt: 456 });
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledWith(456));
  });

  it('does not acknowledge a live push when inbox ingestion fails', async () => {
    const runtime = await import('./unifiedPushRuntime');
    await runtime.initUnifiedPushRuntime();
    ingest.mockRejectedValueOnce(new Error('IndexedDB write failed'));
    await listeners.pushReceived({ payload: '{"metadata":{"charId":"c1"}}', receivedAt: 789 });
    await Promise.resolve();
    await Promise.resolve();
    expect(acknowledge).not.toHaveBeenCalled();
  });


});
