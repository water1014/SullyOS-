# First-party Capacitor Android build

SullyOS no longer requires an external CHICK2 wrapper directory. The repository owns the web source, Capacitor configuration, native plugin source, and repeatable Android project preparation.

## Stable Android identity

- Application ID: `com.aetheros.simulator`
- Display name: `SullyOS·糯米机`
- Capacitor Android runtime: 6.x
- Java toolchain: 17

Do not change the application ID after a signed release. Android uses the package identity and signing certificate to authorize in-place updates.

## Commands

Install dependencies and Android SDK / Java 17 first.

Prepare the web bundle, generate the Android project if missing, install the native plugins, and sync Capacitor without compiling an APK:

```sh
pnpm install --frozen-lockfile
pnpm build:capacitor
```

Compile a local debug APK only when explicitly requested:

```sh
pnpm build:capacitor:apk
```

The debug APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. It is not a release package and is not uploaded by CI.

## Native plugins

`scripts/install-capacitor-android-plugins.mjs` installs and registers:

- `ApkInstallerPlugin`: validates the package ID, version, SHA-256 and installed signing certificate before handing a verified cached APK to Android's system installer.
- `SecureStoragePlugin`: encrypts small secret values with AES-GCM and an Android Keystore key.
- `ScreenAwarenessPlugin` + `ScreenAwarenessService`: starts an Android MediaProjection session only after the system consent dialog, shows an ongoing notification with a stop action, and retains only the latest local JPEG frame.

The installer integrates its `verified-updates/` cache path into the existing Capacitor FileProvider XML resource instead of adding a duplicate provider. It also declares the MediaProjection foreground-service permissions and service. The preparation script is safe to run repeatedly.

Screen awareness is local-only in this phase. It does not upload frames, sync them to the server, or attach them to chat. See `docs/android-screen-awareness.md` for the consent flow and remaining device tests.

## Release safeguards

Do not enable the update manifest or publish an APK until all of the following are complete:

1. A long-lived release signing key has been created and backed up securely outside the repository.
2. CI receives the signing key and passwords only through protected secrets.
3. A signed APK has passed real-device install and in-place update tests.
4. The manifest contains the exact package ID, version code, byte size, SHA-256 and HTTPS download URL.
5. A backup and restore path for user data has been tested.

A debug APK uses a debug signing certificate and cannot be assumed to update a separately signed release app. Do not uninstall an installed app to work around a signature mismatch: uninstalling can delete local app data.

CI compiles a debug APK to validate native integration, but does not upload or publish it. The production updater manifest remains disabled until the release safeguards above are met.
