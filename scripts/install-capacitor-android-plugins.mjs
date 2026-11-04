import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = process.cwd();
const androidRoot = join(root, 'android');
const appRoot = join(androidRoot, 'app');
const javaRoot = join(appRoot, 'src', 'main', 'java');
const manifestPath = join(appRoot, 'src', 'main', 'AndroidManifest.xml');
const pluginRoot = join(root, 'native', 'android');
const packageName = 'com.aetheros.simulator';

async function findFiles(directory, filename, results = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await findFiles(path, filename, results);
    else if (entry.isFile() && entry.name === filename) results.push(path);
  }
  return results;
}

function addImport(source, importLine) {
  if (source.includes(importLine)) return source;
  const packageMatch = source.match(/^package\s+[^;]+;/m);
  if (!packageMatch) throw new Error('MainActivity.java is missing its package declaration');
  const index = packageMatch.index + packageMatch[0].length;
  return source.slice(0, index) + '\n\n' + importLine + source.slice(index);
}

function registerPlugin(source, className) {
  const statement = `registerPlugin(${className}.class);`;
  if (source.includes(statement)) return source;
  const onCreate = /public\\s+void\\s+onCreate\\s*\\(\\s*Bundle\\s+savedInstanceState\\s*\\)\\s*\\{/;
  if (onCreate.test(source)) {
    return source.replace(onCreate, match => match + `\n        ${statement}`);
  }
  const classClose = source.lastIndexOf('}');
  if (classClose < 0) throw new Error('MainActivity.java has no class closing brace');
  const method = `\n    @Override\n    public void onCreate(Bundle savedInstanceState) {\n        ${statement}\n        super.onCreate(savedInstanceState);\n    }\n`;
  return source.slice(0, classClose) + method + source.slice(classClose);
}

async function main() {
  const config = JSON.parse(await readFile(join(root, 'capacitor.config.json'), 'utf8'));
  if (config.appId !== packageName) {
    throw new Error(`Unexpected Capacitor appId: ${config.appId}; native plugins are pinned to ${packageName}`);
  }

  const mainActivities = await findFiles(javaRoot, 'MainActivity.java');
  if (mainActivities.length !== 1) {
    throw new Error(`Expected exactly one generated MainActivity.java, found ${mainActivities.length}`);
  }
  const activityPath = mainActivities[0];
  let activity = await readFile(activityPath, 'utf8');
  if (!activity.includes(`package ${packageName};`)) {
    throw new Error(`MainActivity package does not match ${packageName}: ${relative(root, activityPath)}`);
  }
  if (!activity.includes('extends BridgeActivity')) {
    throw new Error('MainActivity must extend Capacitor BridgeActivity');
  }

  for (const className of ['ApkInstallerPlugin', 'SecureStoragePlugin']) {
    const source = join(pluginRoot, className === 'ApkInstallerPlugin' ? 'apk-installer' : 'secure-storage', `${className}.java`);
    await copyFile(source, join(javaRoot, packageName.split('.').join('/'), `${className}.java`));
    activity = addImport(activity, `import ${packageName}.${className};`);
    activity = registerPlugin(activity, className);
  }
  activity = addImport(activity, 'import android.os.Bundle;');
  await writeFile(activityPath, activity, 'utf8');

  let manifest = await readFile(manifestPath, 'utf8');
  if (!manifest.includes('android.permission.REQUEST_INSTALL_PACKAGES')) {
    const applicationIndex = manifest.indexOf('<application');
    if (applicationIndex < 0) throw new Error('AndroidManifest.xml has no application element');
    manifest = manifest.slice(0, applicationIndex)
      + '    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />\n'
      + manifest.slice(applicationIndex);
  }

  if (!manifest.includes('androidx.core.content.FileProvider')) {
    const provider = [
      '        <provider',
      '            android:name="androidx.core.content.FileProvider"',
      '            android:authorities="${applicationId}.fileprovider"',
      '            android:exported="false"',
      '            android:grantUriPermissions="true">',
      '            <meta-data',
      '                android:name="android.support.FILE_PROVIDER_PATHS"',
      '                android:resource="@xml/apk_installer_paths" />',
      '        </provider>',
    ].join('\n');
    const applicationClose = manifest.lastIndexOf('</application>');
    if (applicationClose < 0) throw new Error('AndroidManifest.xml has no application closing tag');
    manifest = manifest.slice(0, applicationClose) + provider + '\n' + manifest.slice(applicationClose);
  } else {
    const provider = manifest.match(/<provider\\b(?=[^>]*android:name="androidx\\.core\\.content\\.FileProvider")[^>]*>[\\s\\S]*?<\\/provider>/);
    if (!provider
      || !provider[0].includes('android:exported="false"')
      || !provider[0].includes('android:grantUriPermissions="true"')
      || !provider[0].includes('android:authorities="${applicationId}.fileprovider"')
      || !provider[0].includes('android:resource="@xml/apk_installer_paths"')) {
      throw new Error('Existing FileProvider configuration conflicts with the APK installer requirements');
    }
  }
  await writeFile(manifestPath, manifest, 'utf8');

  const xmlDirectory = join(appRoot, 'src', 'main', 'res', 'xml');
  await mkdir(xmlDirectory, { recursive: true });
  await copyFile(
    join(pluginRoot, 'apk-installer', 'apk_installer_paths.xml'),
    join(xmlDirectory, 'apk_installer_paths.xml'),
  );

  process.stdout.write('Android project prepared: APK installer and Android Keystore plugins registered.\n');
}

main().catch(error => {
  process.stderr.write(`Android project preparation failed: ${error.message}\n`);
  process.exitCode = 1;
});
