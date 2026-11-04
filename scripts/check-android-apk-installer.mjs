import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const read = (path) => readFileSync(resolve(process.cwd(), path), 'utf8');
const java = read('native/android/apk-installer/ApkInstallerPlugin.java');
const pathsXml = read('native/android/apk-installer/apk_installer_paths.xml');
const integration = read('scripts/install-apk-installer.ps1');
const update = read('utils/androidAppUpdate.ts');
const capacitor = JSON.parse(read('capacitor.config.json'));

const checks = [
  ['native plugin package matches Capacitor app id', java.includes('package com.aetheros.simulator;') && capacitor.appId === 'com.aetheros.simulator'],
  ['Capacitor plugin name is stable', java.includes('@CapacitorPlugin(name = "ApkInstaller")') && update.includes("registerPlugin<ApkInstallerPlugin>('ApkInstaller')")],
  ['plugin exposes all required methods', ['getInstalledInfo', 'verifyApk', 'installApk', 'openInstallPermissionSettings'].every((name) => java.includes('void ' + name + '('))],
  ['APK path is restricted to app cache', java.includes('getCacheDir().getCanonicalPath()') && java.includes('candidate.startsWith(cache)')],
  ['APK digest is checked natively', java.includes('MessageDigest.getInstance("SHA-256")') && java.includes('actualSha.equals(expectedSha)')],
  ['package, signer and monotonic version are checked natively', java.includes('candidate.packageName') && java.includes('archiveSignerFingerprint(candidate).equals(installedSignerFingerprint(installed))') && java.includes('packageVersionCode(candidate) <= packageVersionCode(installed)')],
  ['system installer receives read-only content URI grant', java.includes('FileProvider.getUriForFile') && java.includes('Intent.FLAG_GRANT_READ_URI_PERMISSION')],
  ['FileProvider exposes only verified update cache', /<cache-path\\s+name="verified_updates"\\s+path="verified-updates\/"\\s*\/>/.test(pathsXml) && !pathsXml.includes('<root-path') && !pathsXml.includes('<external-path')],
  ['wrapper integration declares install permission', integration.includes('android.permission.REQUEST_INSTALL_PACKAGES')],
  ['wrapper integration checks package identity and provider authority', integration.includes('package\\s+com\\.aetheros\\.simulator') && integration.includes('\\$\\{applicationId\\}\\.fileprovider')],
  ['web update flow requires native verification and exact manifest size', update.includes('!verified.valid') && update.includes('Number(fileInfo.size) === manifest.sizeBytes') && update.includes('verified.versionCode <= installed.versionCode')],
];

for (const [label, passed] of checks) {
  assert.equal(passed, true, 'Android APK installer contract failed: ' + label);
  process.stdout.write('✓ ' + label + '\\n');
}
process.stdout.write('\\n' + checks.length + ' Android APK installer contract checks passed.\\n');
