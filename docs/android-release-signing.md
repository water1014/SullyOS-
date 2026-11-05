# Android release signing

This workflow is only for the `feature/image-studio` branch. It creates a signed Release APK and uploads it as a 30-day Actions artifact. It does not publish an APK to Pages or a GitHub Release.

## One-time Actions secrets

Open repository **Settings → Secrets and variables → Actions → New repository secret** and add:

- `ANDROID_KEYSTORE_BASE64`: the complete base64 text from the generated `ANDROID_KEYSTORE_BASE64.txt`.
- `ANDROID_KEYSTORE_PASSWORD`: the keystore password.
- `ANDROID_KEY_ALIAS`: `sullyos-release`.
- `ANDROID_KEY_PASSWORD`: the private-key password.

Do not commit the JKS file, base64 text, or passwords. Keep an offline copy of the JKS and passwords in a safe place. Losing the private key makes future in-place updates impossible.

## Build

Run **Actions → Build signed Android release → Run workflow**, selecting `feature/image-studio`. The workflow checks out that branch explicitly, builds a signed release APK, checks package identity and signature, then stores the APK as an Actions artifact.

The in-app updater remains disabled until the installed app's signer has been checked against the release certificate.

## Existing debug APK migration

A different signer blocks Android's normal in-place update. The safe path is to export a full SullyOS backup from the currently installed app, copy it off the phone, verify the backup, and only then consider uninstalling the old app. Uninstalling deletes its private app data.

Important: the standard backup does not include the isolated `private_visual_blobs` vault or Android Keystore-backed secure-storage entries. These require a separate migration plan if they contain user data. Never describe a backup as complete until those exclusions are handled or confirmed unused.
