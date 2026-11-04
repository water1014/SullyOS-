# Android APK release and data-safety gate

This document is the release gate for the SullyOS Android wrapper. APK packaging is intentionally deferred until the gate is satisfied.

## Installation identity must never drift

- Keep `appId` / Android applicationId exactly `com.aetheros.simulator`.
- Keep the existing production signing keystore and its alias/passwords in private release storage. Never generate a replacement key for an in-place update.
- Every public update must use the same signing certificate as the currently installed app.
- Increase `versionCode` for every APK. Never publish a lower code or reuse a code for different bytes.
- Keep the Capacitor origin stable (`androidScheme: https`, the app's WebView origin). Do not change package ID, app origin, or WebView storage configuration casually.
- Never tell users to uninstall the existing app before installing an update. Uninstalling normally removes app-private data.

## What preserves local data

Android's package installer performs an in-place update when package ID and signing identity match. It does not normally clear the app sandbox. SullyOS stores its main data in IndexedDB database `AetherOS_Data`; preserving the app sandbox and WebView origin is therefore essential.

Schema changes must be additive:
- Increase `DB_VERSION` only when a real migration is needed.
- Create missing stores and indexes idempotently.
- Do not clear, recreate, rename, or change key paths of existing business stores as part of an ordinary release.
- Never add a "reset database" migration to solve an upgrade bug.
- Any unavoidable destructive data conversion requires a separately reviewed export/rollback plan and explicit user-facing migration notice.

The v76 sync migration follows the additive rule and leaves existing business stores untouched. This is not a guarantee against Android storage cleanup, device loss, user-initiated app-data clearing, or a broken future migration. Backups remain mandatory.

## Required release smoke test

Run on a physical Android device using two APKs signed with the same production key:

1. Install the previous release. Do not uninstall it.
2. Create at least one character, chat exchange, diary entry, room note, normal image/blob asset, and private visual asset.
3. Export a full SullyOS backup and verify the archive can be opened.
4. Install the candidate APK over the old installation using Android's package installer.
5. Launch it and verify all seeded records, images, settings, and private records still exist.
6. Verify the IndexedDB migration completed and no migration-aborted/open-error diagnostic appeared.
7. Export another backup and verify it can be imported into a clean test installation.
8. Test app-internal update from the previous build, including download, SHA-256 check, package identity, signing-certificate match, version check, permission prompt, and installer handoff.
9. Reopen the app after installation and confirm the same data is still present.

A release is blocked if any step fails. Do not use a production user's only device as the first migration test.

## In-app update requirements

The web-side updater is in `utils/androidAppUpdate.ts` and `utils/androidUpdateSession.ts`. The manifest is `public/sullyos-update.json`.

The updater must:
- use HTTPS for both manifest and APK;
- validate the manifest schema, version code, APK size metadata, and SHA-256;
- verify APK package identity and signing certificate against the installed app;
- reject a candidate whose versionCode is not newer;
- open Android's system package installer rather than silently installing;
- retain a verified downloaded APK when the user must grant install permission or returns from the installer.

Before publishing an update, set the configured manifest URL to the release manifest and publish the exact APK bytes referenced by it. Recalculate SHA-256 and byte size from the final APK; never copy values from a previous release.

## Current implementation gaps (do not treat as release-ready)

- The TypeScript updater and a native Capacitor `ApkInstaller` source implementation are now tracked under `native/android/apk-installer/`. The native source has not yet been compiled against the actual wrapper project or verified on a device.
- The Android wrapper project remains external to this repository. `scripts/install-apk-installer.ps1` now copies the native source, registers the plugin and FileProvider with guarded checks; `scripts/sync-tiao-capacitor.ps1` invokes it before `cap sync`. The wrapper directory and its exact Android project structure still need validation.
- The checked-in public update manifest is a historical release manifest, not a release target for this feature branch.
- Physical-device in-place upgrade and same-signer update tests have not been run in this repository session.

Therefore the current state is **web updater plus native installer source implemented, wrapper integration and APK release not yet verified**. Before the APK milestone, bring the native installer plugin and wrapper integration under a reproducible, version-controlled release workflow, then complete the smoke test above.

## User backup guidance

Before any major update:
- export a full SullyOS backup;
- copy the archive to a second location outside the phone;
- confirm the archive is non-empty and can be opened;
- keep the previous signed APK and its matching release notes available.

A backup is only useful after restore has been tested. Never promise "data can never be lost"; promise tested in-place upgrades, additive migrations, and a recoverable backup path.
