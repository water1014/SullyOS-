import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const read = (path) => readFileSync(resolve(process.cwd(), path), 'utf8');
const java = read('native/android/apk-installer/ApkInstallerPlugin.java');
const pathsXml = read('native/android/apk-installer/apk_installer_paths.xml');
const integration = read('scripts/install-apk-installer.ps1');
const syncScript = read('scripts/sync-tiao-capacitor.ps1');
const update = read('utils/androidAppUpdate.ts');
const capacitor = JSON.parse(read('capacitor.config.json'));
const updateManifest = JSON.parse(read('public/sullyos-update.json'));
const capacitorEnv = read('.env.capacitor');
const trackedFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split(/\\r?\\n/).filter(Boolean);
const workflowFiles = trackedFiles.filter((path) => path.startsWith('.github/workflows/') && /\\.ya?ml$/i.test(path));
const workflowSources = workflowFiles.map((path) => read(path));

const checks = [
  ['native plugin package matches Capacitor app id', java.includes('package com.aetheros.simulator;') && capacitor.appId === 'com.aetheros.simulator'],
  ['Capacitor plugin name is stable', java.includes('@CapacitorPlugin(name = "ApkInstaller")') && update.includes("registerPlugin<ApkInstallerPlugin>('ApkInstaller')")],
  ['plugin exposes all required methods', ['getInstalledInfo', 'verifyApk', 'installApk', 'openInstallPermissionSettings'].every((name) => java.includes('void ' + name + '('))],
  ['APK path is restricted to app cache', java.includes('getCacheDir().getCanonicalPath()') && java.includes('candidate.startsWith(cache)')],
  ['APK digest is checked natively', java.includes('MessageDigest.getInstance("SHA-256")') && java.includes('actualSha.equals(expectedSha)')],
  ['package, signer and monotonic version are checked natively', java.includes('candidate.packageName') && java.includes('archiveSignerFingerprint(candidate).equals(installedSignerFingerprint(installed))') && java.includes('packageVersionCode(candidate) <= packageVersionCode(installed)')],
  ['system installer receives read-only content URI grant', java.includes('FileProvider.getUriForFile') && java.includes('Intent.FLAG_GRANT_READ_URI_PERMISSION')],
  ['FileProvider exposes only verified update cache', pathsXml.includes('<cache-path name="verified_updates" path="verified-updates/" />') && !pathsXml.includes('<root-path') && !pathsXml.includes('<external-path')],
  ['wrapper integration declares install permission', integration.includes('android.permission.REQUEST_INSTALL_PACKAGES')],
  ['wrapper integration checks package identity and provider authority', integration.includes('package\\s+com\\.aetheros\\.simulator') && integration.includes('android:authorities="${applicationId}.fileprovider"')],
  ['web update flow requires native verification and exact manifest size', update.includes('!verified.valid') && update.includes('Number(fileInfo.size) === manifest.sizeBytes') && update.includes('verified.versionCode <= installed.versionCode')],
  ['APK compilation is opt-in and skipped by default', syncScript.includes('[switch]$BuildDebugApk') && syncScript.includes('if (-not $BuildDebugApk)') && syncScript.includes('pass -BuildDebugApk') && !syncScript.includes('[switch]$SkipAndroidBuild')],
  ['wrapper path boundary and source assets are validated before replacement', syncScript.includes('$wrapperPrefix = $wrapperRoot.TrimEnd') && syncScript.indexOf('$sourceBridgeCount') >= 0 && syncScript.indexOf('$sourceBridgeCount') < syncScript.indexOf('Get-ChildItem -LiteralPath $targetDist -Force | Remove-Item')],
  ['Capacitor sync refuses missing or source-equal wrapper roots and identical dist paths', syncScript.includes("Test-Path -LiteralPath $WrapperRoot -PathType Container") && syncScript.includes('WrapperRoot points to the SullyOS source repository itself') && syncScript.includes('Source and wrapper dist directories resolve to the same path')],
  ['fork update channel stays disabled until its own signed release exists', updateManifest.status === 'disabled' && updateManifest.versionCode === 0 && updateManifest.apkUrl === '' && updateManifest.sha256 === '' && capacitorEnv.split(String.fromCharCode(10)).some((line) => line.trim() === 'VITE_APK_UPDATE_MANIFEST_URL=')],
  ['no APK binary is tracked or staged in the repository', trackedFiles.every((path) => !/\.apk$/i.test(path))],
  ['GitHub workflows do not publish APK releases or APK artifacts', workflowSources.every((source) => !/softprops\/action-gh-release|gh\s+release\s+(?:create|upload)/i.test(source) && !/(?:upload-artifact|upload-pages-artifact)[\s\S]{0,1200}\.apk/i.test(source))],
];

for (const [label, passed] of checks) {
  assert.equal(passed, true, 'Android APK installer contract failed: ' + label);
  process.stdout.write('✓ ' + label + String.fromCharCode(10));
}
process.stdout.write(String.fromCharCode(10) + checks.length + ' Android APK installer contract checks passed.' + String.fromCharCode(10));
