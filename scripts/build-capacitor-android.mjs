import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const androidRoot = join(root, 'android');
const androidApp = join(androidRoot, 'app');
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const windows = process.platform === 'win32';

function run(command, args, cwd = root, envOverrides = {}) {
  process.stdout.write(`\n> ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: windows,
    env: { ...process.env, ...envOverrides },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed with exit code ${result.status}: ${command} ${args.join(' ')}`);
  }
}

async function main() {
  const buildMigration = process.argv.includes('--migration');
  const buildRelease = process.argv.includes('--release');
  if (buildMigration && buildRelease) throw new Error('Choose either --migration or --release, not both.');
  const buildSigned = buildMigration || buildRelease;
  const buildApk = process.argv.includes('--apk') || buildSigned;
  if (buildSigned) {
    const required = ['ANDROID_KEYSTORE_PATH', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD'];
    const missing = required.filter(name => !process.env[name]);
    if (missing.length) throw new Error(`Missing release signing environment: ${missing.join(', ')}`);
    if (!existsSync(process.env.ANDROID_KEYSTORE_PATH)) throw new Error('Release keystore file was not found.');
  }

  run(pnpmCommand, ['run', 'build:chat-preview']);
  run(pnpmCommand, ['run', 'build:workers']);
  // Personal Android APK: hide the branch badge and its floating developer wrench.
  run(pnpmCommand, ['exec', 'vite', 'build', '--mode', 'capacitor'], root, { VITE_HIDE_BUILD_BADGE: '1' });

  if (!existsSync(androidApp)) {
    if (existsSync(androidRoot)) {
      throw new Error('The android directory exists but has no app module. Move or repair that incomplete directory before continuing.');
    }
    run(pnpmCommand, ['exec', 'cap', 'add', 'android']);
  }

  run(pnpmCommand, ['prepare:android']);
  run(pnpmCommand, ['exec', 'cap', 'sync', 'android']);

  if (!buildApk) {
    process.stdout.write('\nCapacitor Android project is ready. APK compilation was skipped.\n');
    process.stdout.write('Use the separate build:capacitor:apk command only when a debug APK is explicitly needed.\n');
    return;
  }

  const appGradle = join(androidApp, 'build.gradle');
  if (buildSigned) {
    const versionCode = Number(process.env.ANDROID_VERSION_CODE || (buildMigration ? 30401 : 30402));
    const versionName = String(process.env.ANDROID_VERSION_NAME || (buildMigration ? '3.17.0-migration' : '3.17.0')).trim();
    if (!Number.isSafeInteger(versionCode) || versionCode < 2 || !versionName) throw new Error('Release version is invalid.');
    let gradle = readFileSync(appGradle, 'utf8');
    if (!/defaultConfig\s*\{/.test(gradle) || !/versionCode\s+\d+/.test(gradle) || !/versionName\s+['"][^'"]+['"]/.test(gradle)) {
      throw new Error('Generated app/build.gradle has no recognizable version fields.');
    }
    gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`);
    gradle = gradle.replace(/versionName\s+['"][^'"]+['"]/, `versionName "${versionName.replace(/["\\\\]/g, '')}"`);
    if (!gradle.includes("apply from: 'signing.gradle'")) gradle += "\n\napply from: 'signing.gradle'\n";
    writeFileSync(appGradle, gradle, 'utf8');
    writeFileSync(join(androidApp, 'signing.gradle'), `
def signingStorePath = System.getenv('ANDROID_KEYSTORE_PATH')
def signingStorePassword = System.getenv('ANDROID_KEYSTORE_PASSWORD')
def signingKeyAlias = System.getenv('ANDROID_KEY_ALIAS')
def signingKeyPassword = System.getenv('ANDROID_KEY_PASSWORD')
if (!signingStorePath || !signingStorePassword || !signingKeyAlias || !signingKeyPassword) {
    throw new GradleException('Release signing environment is incomplete.')
}
android {
    signingConfigs {
        release {
            storeFile file(signingStorePath)
            storePassword signingStorePassword
            keyAlias signingKeyAlias
            keyPassword signingKeyPassword
        }
    }
    buildTypes {
        release { signingConfig signingConfigs.release }
        debug {
            signingConfig signingConfigs.release
            debuggable true
        }
    }
}
`, 'utf8');
  }

  const wrapper = windows ? 'gradlew.bat' : './gradlew';
  run(wrapper, [buildRelease ? 'assembleRelease' : 'assembleDebug', '--no-daemon'], androidRoot);
  const variant = buildRelease ? 'release' : 'debug';
  const apkName = buildRelease ? 'app-release.apk' : 'app-debug.apk';
  const apkPath = join(androidApp, 'build', 'outputs', 'apk', variant, apkName);
  if (!existsSync(apkPath)) throw new Error(`Gradle reported success but the ${variant} APK was not found.`);
  const sha256 = createHash('sha256').update(readFileSync(apkPath)).digest('hex');
  process.stdout.write(`\n${buildMigration ? 'Signed debuggable migration' : buildRelease ? 'Signed release' : 'Debug test'} APK compiled: ${apkPath}\nSHA-256: ${sha256}\n`);
  if (buildSigned) run(process.env.APKSIGNER_PATH || 'apksigner', ['verify', '--verbose', '--print-certs', apkPath]);

}

main().catch(error => {
  process.stderr.write(`Capacitor Android build failed: ${error.message}\n`);
  process.exitCode = 1;
});
