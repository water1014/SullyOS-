import { Capacitor, registerPlugin } from '@capacitor/core';

export interface ScreenAwarenessStatus {
  active: boolean;
  frozen: boolean;
  latestFrameAt: number;
}

export interface ScreenAwarenessFrame {
  mimeType: 'image/jpeg';
  base64: string;
  capturedAt: number;
  localOnly: true;
}

interface ScreenAwarenessNative {
  startSession(): Promise<{ active: boolean; alreadyRunning?: boolean; requiresVisibleNotification?: boolean; localOnly?: boolean }>;
  stopSession(): Promise<{ active: boolean }>;
  resumeSession(): Promise<{ active: boolean; frozen: boolean }>;
  getStatus(): Promise<ScreenAwarenessStatus>;
  getLatestFrame(): Promise<ScreenAwarenessFrame>;
  clearLatestFrame(): Promise<{ cleared: boolean }>;
}

const NativeScreenAwareness = registerPlugin<ScreenAwarenessNative>('ScreenAwareness');

export function isScreenAwarenessAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

function assertAvailable(): void {
  if (!isScreenAwarenessAvailable()) {
    throw new Error('整机屏幕感知仅支持 Android 原生 App，网页预览无法调用');
  }
}

export async function startScreenAwareness(): Promise<void> {
  assertAvailable();
  await NativeScreenAwareness.startSession();
}

export async function stopScreenAwareness(): Promise<void> {
  assertAvailable();
  await NativeScreenAwareness.stopSession();
}

export async function resumeScreenAwareness(): Promise<void> {
  assertAvailable();
  await NativeScreenAwareness.resumeSession();
}

export async function getScreenAwarenessStatus(): Promise<ScreenAwarenessStatus> {
  assertAvailable();
  return NativeScreenAwareness.getStatus();
}

export async function getLatestScreenFrame(): Promise<ScreenAwarenessFrame> {
  assertAvailable();
  return NativeScreenAwareness.getLatestFrame();
}

export async function clearLatestScreenFrame(): Promise<void> {
  assertAvailable();
  const result = await NativeScreenAwareness.clearLatestFrame();
  if (!result.cleared) throw new Error('本机屏幕缓存未能清理');
}
