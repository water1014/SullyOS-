# Android whole-phone screen awareness

The Android implementation is a user-started, consent-based MediaProjection session. It is not an AccessibilityService and does not silently inspect other apps.

## User flow

1. Open Settings → 手机与屏幕感知.
2. Tap 授权并开启.
3. Android displays its official screen-sharing consent dialog. If the user cancels, capture does not start.
4. While active, a persistent foreground-service notification says screen awareness is running and exposes a 停止感知 action.
5. The app keeps only the latest JPEG frame in its private cache, sampling at most once every three seconds.
6. The user can preview the local frame or stop the session. Stopping releases MediaProjection, VirtualDisplay and ImageReader, and deletes the cached frame.

## Privacy boundaries

- No automatic network upload, cloud sync, chat attachment, or model call is implemented.
- Screenshots are stored only in the app's private cache directory and the previous frame is replaced.
- The Android system consent dialog is required for every new capture session.
- The persistent notification remains visible while the foreground service is active.
- Screenshots from Android secure surfaces, DRM playback and apps using FLAG_SECURE may appear blank or be excluded.
- The current first phase samples the current display size/orientation. For a major orientation or display-mode change, stop and start a new session.
- Android may revoke the projection at any time. The service then stops and clears the temporary frame.

## Platform requirements

- Android 5.0+ for MediaProjection itself.
- Android 10+ foreground-service mediaProjection type is declared where supported.
- Android 14+ requires FOREGROUND_SERVICE_MEDIA_PROJECTION and the per-session system consent flow.
- The app must start the foreground service while its activity is visible and after consent.

## Not yet implemented

- Passing a selected screenshot into a chat turn.
- OCR or on-device visual summarization.
- User-configurable sampling interval.
- Device-specific rotation / foldable display reconfiguration.
- Real-device validation across Android 12–16 and vendor battery-management policies.

Do not describe this first phase as AI continuously understanding the phone. It provides an explicit, stoppable local capture foundation only.