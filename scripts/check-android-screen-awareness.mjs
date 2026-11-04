import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const plugin = read('../native/android/screen-awareness/ScreenAwarenessPlugin.java');
const service = read('../native/android/screen-awareness/ScreenAwarenessService.java');
const installer = read('./install-capacitor-android-plugins.mjs');
const ui = read('../components/settings/ScreenAwarenessSettingsPanel.tsx');
const bridge = read('../utils/androidScreenAwareness.ts');

const checks = [
  ['screen capture requires Android system consent for each session', plugin.includes('createScreenCaptureIntent()') && plugin.includes('startActivityForResult(call') && plugin.includes('Activity.RESULT_OK')],
  ['screen capture can only start from an explicit user-facing plugin call', plugin.includes('void startSession(PluginCall call)') && !plugin.includes('load()') && !plugin.includes('handleOnResume')],
  ['foreground service declares media projection type', service.includes('FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION') && installer.includes('android:foregroundServiceType="mediaProjection"')],
  ['foreground service notification is ongoing and has an explicit stop action', service.includes('setOngoing(true)') && service.includes('addAction(') && service.includes('ACTION_STOP')],
  ['Android 14 media projection permission is added', installer.includes('android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION') && installer.includes('android.permission.FOREGROUND_SERVICE')],
  ['native installer registers plugin and service source', installer.includes('ScreenAwarenessPlugin') && installer.includes('ScreenAwarenessService.java')],
  ['only one latest JPEG frame is retained in app cache', service.includes('new File(directory, "latest.jpg")') && service.includes('new File(directory, "latest.tmp")') && service.includes('FRAME_INTERVAL_MS')],
  ['screen frames are not sent to network services by native capture code', !/https?\\.|HttpURLConnection|OkHttp|WebSocket|upload/i.test(service)],
  ['stop operation releases projection, virtual display, reader and cached frame', service.includes('virtualDisplay.release()') && service.includes('imageReader.close()') && service.includes('current.stop()') && service.includes('frame.delete()')],
  ['UI explains local-only behavior and provides visible stop action', ui.includes('不会自动上传云端') && ui.includes('停止感知') && ui.includes('授权并开启')],
  ['web preview cannot access native screen capture', bridge.includes("Capacitor.getPlatform() === 'android'") && bridge.includes('assertAvailable()')],
  ['no screenshot is automatically attached to chat or cloud sync', !/sendMessage|upload|fetch\\(/i.test(bridge) && !/sendMessage|upload|fetch\\(/i.test(ui)],
];

for (const [label, passed] of checks) {
  assert.equal(passed, true, 'Android screen awareness contract failed: ' + label);
  process.stdout.write('✓ ' + label + String.fromCharCode(10));
}
process.stdout.write(String.fromCharCode(10) + checks.length + ' Android screen awareness contract checks passed.' + String.fromCharCode(10));
