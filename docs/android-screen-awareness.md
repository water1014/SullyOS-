# Android whole-phone screen awareness

The Android implementation is a user-started, consent-based MediaProjection session. It is not an AccessibilityService and does not silently inspect other apps.

## User flow

1. Open Settings → 手机与屏幕感知.
2. Tap 授权并开启.
3. Android displays its official screen-sharing consent dialog. If the user cancels, capture does not start.
4. While active, a persistent foreground-service notification exposes 截取此刻 and 停止感知 actions.
5. When the user is in another app, they tap 截取此刻 in the notification. The service saves the next frame and detaches the virtual-display output, pausing capture work so returning to SullyOS does not overwrite the other app's screen with the chat UI.
6. In chat, the user opens ＋ → 分享屏幕, previews the frozen frame, and must explicitly confirm before it is sent as an ordinary image message.
7. The user can resume capture from the notification or Settings. Stopping releases MediaProjection, VirtualDisplay and ImageReader, and deletes the cached frame.

## Privacy boundaries

- No automatic network upload or cloud sync is implemented. A screenshot enters chat only after the user freezes it, previews it, and taps 确认发送给角色.
- Screenshots are stored only in the app's private cache directory and the previous frame is replaced.
- The Android system consent dialog is required for every new capture session.
- The persistent notification remains visible while the foreground service is active and provides capture/resume/stop controls.
- Screenshots from Android secure surfaces, DRM playback and apps using FLAG_SECURE may appear blank or be excluded.
- The current first phase samples the current display size/orientation. For a major orientation or display-mode change, stop and start a new session.
- Android may revoke the projection at any time. The service then stops and clears the temporary frame.

## Platform requirements

- Android 5.0+ for MediaProjection itself.
- Android 10+ foreground-service mediaProjection type is declared where supported.
- Android 14+ requires FOREGROUND_SERVICE_MEDIA_PROJECTION and the per-session system consent flow.
- The app must start the foreground service while its activity is visible and after consent.

## Not yet implemented

- Automatic OCR or continuous visual summarization.
- OCR or on-device visual summarization.
- User-configurable sampling interval.
- Device-specific rotation / foldable display reconfiguration.
- Real-device validation across Android 12–16 and vendor battery-management policies.

Do not describe this first phase as AI continuously understanding the phone. It provides an explicit, stoppable local capture foundation only.