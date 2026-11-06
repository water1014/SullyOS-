import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getNativeStatus } = vi.hoisted(() => ({
  getNativeStatus: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
  },
  registerPlugin: () => ({ getStatus: getNativeStatus }),
}));

vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: vi.fn().mockResolvedValue({ display: 'granted' }),
    requestPermissions: vi.fn(),
  },
}));

import { ensureUnifiedPushSubscription, getUnifiedPushStatus } from './unifiedPushPlugin';

describe('UnifiedPush native bridge capability', () => {
  beforeEach(() => {
    getNativeStatus.mockReset();
  });

  it('reports a missing Android native plugin instead of showing an empty healthy state', async () => {
    getNativeStatus.mockRejectedValue(new Error('Plugin not implemented'));
    const status = await getUnifiedPushStatus();

    expect(status.native).toBe(true);
    expect(status.subscription).toBeNull();
    expect(status.lastError).toContain('当前 APK 未安装 UnifiedPush 原生桥接插件');
    expect(status.permission).toBe('granted');
  });

  it('returns an actionable error when registration is attempted without the native plugin', async () => {
    getNativeStatus.mockRejectedValue(new Error('Plugin not implemented'));

    await expect(ensureUnifiedPushSubscription('test-vapid-key'))
      .rejects.toThrow('当前 APK 未包含 UnifiedPush 原生插件');
  });
});
