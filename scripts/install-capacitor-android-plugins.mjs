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
  const onCreate = 'public void onCreate(Bundle savedInstanceState) {';
  if (source.includes(onCreate)) {
    return source.replace(onCreate, onCreate + `\n        ${statement}`);
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

  const plugins = [
    { className: 'ApkInstallerPlugin', directory: 'apk-installer' },
    { className: 'SecureStoragePlugin', directory: 'secure-storage' },
    { className: 'ScreenAwarenessPlugin', directory: 'screen-awareness' },
    { className: 'AndroidSafeAreaPlugin', directory: 'android-safe-area' },
    { className: 'OpenCodeGoStreamPlugin', directory: 'opencode-go-stream' },
    { className: 'AmsgUnifiedPushPlugin', directory: 'unified-push' },
  ];
  for (const plugin of plugins) {
    const source = join(pluginRoot, plugin.directory, `${plugin.className}.java`);
    await copyFile(source, join(javaRoot, packageName.split('.').join('/'), `${plugin.className}.java`));
    activity = addImport(activity, `import ${packageName}.${plugin.className};`);
    activity = registerPlugin(activity, plugin.className);
  }
  const serviceSource = join(pluginRoot, 'screen-awareness', 'ScreenAwarenessService.java');
  await copyFile(serviceSource, join(javaRoot, packageName.split('.').join('/'), 'ScreenAwarenessService.java'));
  for (const file of ['AmsgUnifiedPushService.java', 'AmsgNotificationTapReceiver.java']) {
    await copyFile(join(pluginRoot, 'unified-push', file), join(javaRoot, packageName.split('.').join('/'), file));
  }
  activity = addImport(activity, 'import android.os.Bundle;');
  await writeFile(activityPath, activity, 'utf8');

  let manifest = await readFile(manifestPath, 'utf8');
  const requiredPermissions = [
    'android.permission.REQUEST_INSTALL_PACKAGES',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION',
    'android.permission.POST_NOTIFICATIONS',
  ];
  const missingPermissions = requiredPermissions.filter(permission =>
    !manifest.includes(`android:name="${permission}"`)
  );
  if (missingPermissions.length > 0) {
    const applicationIndex = manifest.indexOf('<application');
    if (applicationIndex < 0) throw new Error('AndroidManifest.xml has no application element');
    const declarations = missingPermissions
      .map(permission => `    <uses-permission android:name="${permission}" />`)
      .join('\n');
    manifest = manifest.slice(0, applicationIndex) + declarations + '\n' + manifest.slice(applicationIndex);
  }
  const serviceName = 'android:name=".ScreenAwarenessService"';
  if (!manifest.includes(serviceName)) {
    const service = [
      '        <service',
      '            android:name=".ScreenAwarenessService"',
      '            android:exported="false"',
      '            android:foregroundServiceType="mediaProjection" />',
    ].join('\n');
    const applicationClose = manifest.lastIndexOf('</application>');
    if (applicationClose < 0) throw new Error('AndroidManifest.xml has no application closing tag');
    manifest = manifest.slice(0, applicationClose) + service + '\n' + manifest.slice(applicationClose);
  }

  let xmlResourceName = 'apk_installer_paths';
  const providerMarker = 'android:name="androidx.core.content.FileProvider"';
  if (!manifest.includes(providerMarker)) {
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
    const markerIndex = manifest.indexOf(providerMarker);
    const providerStart = manifest.lastIndexOf('<provider', markerIndex);
    const providerEnd = manifest.indexOf('</provider>', markerIndex);
    const provider = providerStart < 0 || providerEnd < 0
      ? ''
      : manifest.slice(providerStart, providerEnd + '</provider>'.length);
    if (!provider.includes('android:exported="false"')
      || !provider.includes('android:grantUriPermissions="true"')
      || !provider.includes('android:authorities="${applicationId}.fileprovider"')) {
      throw new Error('Existing FileProvider must be non-exported, use the app authority, and grant URI access');
    }
    const resourceMarker = 'android:resource="@xml/';
    const resourceStart = provider.indexOf(resourceMarker);
    const resourceEnd = resourceStart < 0 ? -1 : provider.indexOf('"', resourceStart + resourceMarker.length);
    if (resourceEnd < 0) throw new Error('Existing FileProvider has no XML paths resource');
    xmlResourceName = provider.slice(resourceStart + resourceMarker.length, resourceEnd);
    if (!/^[a-z][a-z0-9_]*$/.test(xmlResourceName)) {
      throw new Error('Existing FileProvider XML resource name is invalid');
    }
  }
  const unifiedPushService = 'android:name=".AmsgUnifiedPushService"';
  if (!manifest.includes(unifiedPushService)) {
    const service = [
      '        <service',
      '            android:name=".AmsgUnifiedPushService"',
      '            android:exported="false">',
      '            <intent-filter>',
      '                <action android:name="org.unifiedpush.android.connector.PUSH_EVENT" />',
      '            </intent-filter>',
      '        </service>',
    ].join('\n');
    const applicationClose = manifest.lastIndexOf('</application>');
    if (applicationClose < 0) throw new Error('AndroidManifest.xml has no application closing tag');
    manifest = manifest.slice(0, applicationClose) + service + '\n' + manifest.slice(applicationClose);
  }
  const tapReceiver = 'android:name=".AmsgNotificationTapReceiver"';
  if (!manifest.includes(tapReceiver)) {
    const receiver = [
      '        <receiver',
      '            android:name=".AmsgNotificationTapReceiver"',
      '            android:exported="false" />',
    ].join('\n');
    const applicationClose = manifest.lastIndexOf('</application>');
    if (applicationClose < 0) throw new Error('AndroidManifest.xml has no application closing tag');
    manifest = manifest.slice(0, applicationClose) + receiver + '\n' + manifest.slice(applicationClose);
  }
  await writeFile(manifestPath, manifest, 'utf8');

  const xmlDirectory = join(appRoot, 'src', 'main', 'res', 'xml');
  await mkdir(xmlDirectory, { recursive: true });
  const xmlPath = join(xmlDirectory, `${xmlResourceName}.xml`);
  const sourceXmlPath = join(pluginRoot, 'apk-installer', 'apk_installer_paths.xml');
  let pathsXml;
  try {
    pathsXml = await readFile(xmlPath, 'utf8');
  } catch {
    pathsXml = await readFile(sourceXmlPath, 'utf8');
  }
  const requiredCachePath = '<cache-path name="verified_updates" path="verified-updates/" />';
  if (pathsXml.includes('name="verified_updates"') && !pathsXml.includes(requiredCachePath)) {
    throw new Error('Existing FileProvider already defines verified_updates with a different path');
  }
  if (!pathsXml.includes(requiredCachePath)) {
    const pathsClose = pathsXml.lastIndexOf('</paths>');
    if (pathsClose < 0) throw new Error('FileProvider XML resource has no paths closing tag');
    pathsXml = pathsXml.slice(0, pathsClose) + '    ' + requiredCachePath + '\n' + pathsXml.slice(pathsClose);
  }
  await writeFile(xmlPath, pathsXml, 'utf8');

  const appGradlePath = join(appRoot, 'build.gradle');
  let appGradle = await readFile(appGradlePath, 'utf8');
  const unifiedPushDependency = "implementation 'org.unifiedpush.android:connector:3.3.3'";
  if (!appGradle.includes('org.unifiedpush.android:connector:')) {
    const dependenciesMatch = appGradle.match(/dependencies\s*\{/);
    if (!dependenciesMatch) throw new Error('Generated app/build.gradle has no dependencies block');
    const insertAt = dependenciesMatch.index + dependenciesMatch[0].length;
    appGradle = appGradle.slice(0, insertAt) + '\n    ' + unifiedPushDependency + appGradle.slice(insertAt);
  }
  await writeFile(appGradlePath, appGradle, 'utf8');

  process.stdout.write('Android project prepared: APK installer, Android Keystore, and UnifiedPush plugins registered.\n');
}

main().catch(error => {
  process.stderr.write(`Android project preparation failed: ${error.message}\n`);
  process.exitCode = 1;
});
