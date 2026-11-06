import type { PluginListenerHandle } from '@capacitor/core';
import { ingestNativeAmsgPayload, parseNativeAmsgPayload } from './nativeAmsgInbox';
import { addUnifiedPushListener, drainUnifiedPushMessages, isUnifiedPushPlatform } from './unifiedPushPlugin';

let initialized = false;
let listenerHandles: PluginListenerHandle[] = [];

const ingest = async (payload: unknown, openAfter = false): Promise<void> => {
  const result = await ingestNativeAmsgPayload(payload);
  if (openAfter && result?.charId) {
    window.dispatchEvent(new CustomEvent('active-msg-open', { detail: { charId: result.charId } }));
  }
};

export const initUnifiedPushRuntime = async (): Promise<void> => {
  if (initialized || !isUnifiedPushPlatform()) return;
  // Mark ready only after listeners and the cold-start inbox have been restored.
  // If the native bridge is absent or temporarily unavailable, allow a later
  // foreground retry instead of permanently locking this runtime in a failed state.
  try {
    const receivedHandle = await addUnifiedPushListener('pushReceived', (event) => {
      void ingest(event?.payload).catch((error) =>
        console.warn('[ActiveMsg:UnifiedPush] 收到推送后处理失败', error));
    });
    listenerHandles = [receivedHandle];
    const tappedHandle = await addUnifiedPushListener('notificationTapped', (event) => {
      void ingest(event?.payload, true).catch((error) =>
        console.warn('[ActiveMsg:UnifiedPush] 通知点击处理失败', error));
    });

    listenerHandles = [receivedHandle, tappedHandle];
    const pending = await drainUnifiedPushMessages();
    for (const message of pending.messages || []) {
      await ingest(message.payload);
    }

    if (pending.launchPayload) {
      const payload = parseNativeAmsgPayload(pending.launchPayload);
      const charId = payload?.metadata?.charId;
      if (typeof charId === 'string' && charId) {
        window.dispatchEvent(new CustomEvent('active-msg-open', { detail: { charId } }));
      }
    }
    initialized = true;
  } catch (error) {
    await Promise.all(listenerHandles.map((handle) => handle.remove().catch(() => undefined)));
    listenerHandles = [];
    console.warn('[ActiveMsg:UnifiedPush] Android 原生推送桥不可用，等待下次恢复时重试', error);
  }
};
