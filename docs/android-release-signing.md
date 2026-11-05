# Android signing and one-time migration

All Android package work is restricted to `feature/image-studio`. The release workflow is manually dispatched and stores APKs only as 30-day Actions artifacts. It does not publish APKs to Pages or a GitHub Release.

## Signing key

The stable keystore is never committed. Add these repository Actions secrets:

- `ANDROID_KEYSTORE_BASE64`: base64 text of the JKS file.
- `ANDROID_KEYSTORE_PASSWORD`: keystore password.
- `ANDROID_KEY_ALIAS`: `sullyos-release`.
- `ANDROID_KEY_PASSWORD`: private-key password.

Keep an offline copy of the JKS and passwords. Losing the private key makes future in-place updates impossible.

## Why a one-time migration is required

The historical GitHub Actions APKs were signed by runner-local debug keys. Different builds had different signing fingerprints, so Android cannot accept the new stable signer as an in-place update. Do not uninstall the old app until its data archive has been verified.

The workflow creates two APKs with the same new stable signer and same package ID:
1. **Migration APK**: debuggable, installed only after the old app data has been safely archived. It allows the on-device `run-as` restore step.
2. **Final Release APK**: non-debuggable, higher versionCode, installed over the migration APK after data restoration.

## Phone-only raw app-data migration

The historical APKs were built with Gradle `assembleDebug`, so they should be debuggable. First install a local ADB shell app such as LADB and pair it with Android Wireless debugging. Before uninstalling anything, run:

```sh
run-as com.aetheros.simulator id
```

If this fails, STOP. Do not uninstall the old app. The migration procedure depends on `run-as` access.

Force-stop the old app and archive its entire private app data directory, excluding disposable caches and the old Keystore ciphertext preferences:

```sh
am force-stop com.aetheros.simulator
run-as com.aetheros.simulator tar -cpf - --exclude=./cache --exclude=./code_cache --exclude=./app_webview/Default/Cache --exclude=./shared_prefs/sullyos_secure_storage_v1.xml . > /sdcard/Download/SullyOS-migration.tar
ls -lh /sdcard/Download/SullyOS-migration.tar
tar -tf /sdcard/Download/SullyOS-migration.tar | grep -E 'app_webview/Default/(IndexedDB|Local Storage)' | head
```

Copy the TAR archive to a second safe location before proceeding. Only after the file exists and contains both IndexedDB and Local Storage entries may the old app be uninstalled.

Install the **Migration APK** from the workflow artifact. Launch it once, close it, then use the ADB shell:

```sh
am force-stop com.aetheros.simulator
cat /sdcard/Download/SullyOS-migration.tar | run-as com.aetheros.simulator tar -xpf -
```

Launch the app and verify characters, conversations, worldbooks, API settings, local files, and visual memories. The raw WebView app-data archive carries all WebView Local Storage and IndexedDB files, including private visual records/blobs that the normal backup intentionally excludes.

Finally install the **Final Release APK**. It has the same package ID and stable signing certificate as the Migration APK, and a higher versionCode, so Android should treat it as a normal in-place update and preserve the restored data.

## Important limitations

- Android Keystore private keys are not exportable. The old `sullyos_secure_storage_v1.xml` encrypted preferences are deliberately excluded from the archive because their old Keystore key will be destroyed on uninstall. Credentials stored there must be re-paired/re-entered. Ordinary app Local Storage and IndexedDB are preserved byte-for-byte.
- If the old app does not pass the `run-as` preflight, do not uninstall it. We must use another migration route.
- Keep the TAR backup until all data and features have been verified. Never upload it to a public repository or share it; it may contain API credentials and private conversations.
