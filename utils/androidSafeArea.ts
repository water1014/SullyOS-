import { Capacitor, registerPlugin } from '@capacitor/core';

interface AndroidSafeAreaResult {
  topInsetPx: number;
  topInsetDp: number;
  density: number;
  hasDisplayCutout: boolean;
}

interface AndroidSafeAreaPlugin {
  getInsets(): Promise<AndroidSafeAreaResult>;
}

const AndroidSafeArea = registerPlugin<AndroidSafeAreaPlugin>('AndroidSafeArea');

/** Refresh the physical status-bar / camera-cutout inset and expose it to CSS in dp. */
export async function refreshAndroidSafeArea(): Promise<void> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return;
  try {
    const insets = await AndroidSafeArea.getInsets();
    if (!Number.isFinite(insets.topInsetDp) || insets.topInsetDp < 0) return;
    document.documentElement.style.setProperty('--android-safe-area-top', `${insets.topInsetDp}px`);
    document.documentElement.style.setProperty('--safe-top', `${insets.topInsetDp}px`);
    document.documentElement.classList.add('sully-android-native');
  } catch (error) {
    console.warn('[AndroidSafeArea] Could not refresh display cutout inset', error);
  }
}
