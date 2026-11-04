import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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
  const buildApk = process.argv.includes('--apk');

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

  const wrapper = windows ? 'gradlew.bat' : './gradlew';
  run(wrapper, ['assembleDebug', '--no-daemon'], androidRoot);

  const apkPath = join(androidRoot, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  if (!existsSync(apkPath)) throw new Error('Gradle reported success but the debug APK was not found.');
  const sha256 = createHash('sha256').update(readFileSync(apkPath)).digest('hex');
  process.stdout.write(`\nDebug APK compiled (not a release build): ${apkPath}\nSHA-256: ${sha256}\n`);
}

main().catch(error => {
  process.stderr.write(`Capacitor Android build failed: ${error.message}\n`);
  process.exitCode = 1;
});
