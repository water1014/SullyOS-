[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$WrapperRoot
)

$ErrorActionPreference = 'Stop'

function Write-Utf8NoBom {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Value
  )
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Value, $encoding)
}
$androidRoot = Join-Path $WrapperRoot 'android'
$appRoot = Join-Path $androidRoot 'app'
$javaSource = Join-Path $PSScriptRoot '..\native\android\apk-installer\ApkInstallerPlugin.java'
$xmlSource = Join-Path $PSScriptRoot '..\native\android\apk-installer\apk_installer_paths.xml'

if (-not (Test-Path -LiteralPath $appRoot)) { throw "Android app module not found: $appRoot" }
if (-not (Test-Path -LiteralPath $javaSource)) { throw "ApkInstaller Java source missing: $javaSource" }
if (-not (Test-Path -LiteralPath $xmlSource)) { throw "FileProvider paths XML missing: $xmlSource" }

$mainActivity = Get-ChildItem -LiteralPath $appRoot -Filter 'MainActivity.java' -Recurse -File |
  Select-Object -First 1
if (-not $mainActivity) { throw 'MainActivity.java not found. Refusing to guess the Android package path.' }

$activityContent = Get-Content -LiteralPath $mainActivity.FullName -Raw
if ($activityContent -notmatch 'package\s+com\.aetheros\.simulator\s*;') {
  throw 'MainActivity package is not com.aetheros.simulator. Review the wrapper identity before installing ApkInstaller.'
}

$javaTarget = Join-Path $mainActivity.DirectoryName 'ApkInstallerPlugin.java'
Copy-Item -LiteralPath $javaSource -Destination $javaTarget -Force

$xmlDirectory = Join-Path $appRoot 'src\main\res\xml'
New-Item -ItemType Directory -Path $xmlDirectory -Force | Out-Null
Copy-Item -LiteralPath $xmlSource -Destination (Join-Path $xmlDirectory 'apk_installer_paths.xml') -Force

if ($activityContent -notmatch 'import\s+com\.aetheros\.simulator\.ApkInstallerPlugin\s*;') {
  $activityContent = [regex]::Replace(
    $activityContent,
    '(?m)^(package\s+[^;]+;)',
    '$1' + [Environment]::NewLine + 'import com.aetheros.simulator.ApkInstallerPlugin;',
    1
  )
}
if ($activityContent -notmatch 'registerPlugin\(ApkInstallerPlugin\.class\)') {
  if ($activityContent -match 'public\s+void\s+onCreate\s*\(Bundle\s+savedInstanceState\)\s*\{') {
    $activityContent = [regex]::Replace(
      $activityContent,
      '(public\s+void\s+onCreate\s*\(Bundle\s+savedInstanceState\)\s*\{)',
      '$1' + [Environment]::NewLine + '        registerPlugin(ApkInstallerPlugin.class);',
      1
    )
  } else {
    if ($activityContent -notmatch 'import\s+android\.os\.Bundle\s*;') {
      $activityContent = [regex]::Replace(
        $activityContent,
        '(?m)^(package\s+[^;]+;)',
        '$1' + [Environment]::NewLine + 'import android.os.Bundle;',
        1
      )
    }
    $lastBrace = $activityContent.LastIndexOf('}')
    if ($lastBrace -lt 0) { throw 'MainActivity class closing brace not found.' }
    $method = @'
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ApkInstallerPlugin.class);
        super.onCreate(savedInstanceState);
    }

'@
    $activityContent = $activityContent.Insert($lastBrace, $method)
  }
}
Write-Utf8NoBom -Path $mainActivity.FullName -Value $activityContent

$manifestPath = Join-Path $appRoot 'src\main\AndroidManifest.xml'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "AndroidManifest.xml not found: $manifestPath" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw
if ($manifest -notmatch 'android\.permission\.REQUEST_INSTALL_PACKAGES') {
  if ($manifest -notmatch '</manifest>') { throw 'AndroidManifest.xml has no manifest closing tag.' }
  $permission = '    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />' + [Environment]::NewLine
  $manifest = $manifest.Replace('</manifest>', $permission + '</manifest>')
  Write-Utf8NoBom -Path $manifestPath -Value $manifest
}
if ($manifest -notmatch 'androidx\.core\.content\.FileProvider') {
  $provider = @'
        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="${applicationId}.fileprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/apk_installer_paths" />
        </provider>
'@
  if ($manifest -notmatch '</application>') { throw 'AndroidManifest.xml has no application closing tag.' }
  $manifest = $manifest.Replace('</application>', $provider + [Environment]::NewLine + '    </application>')
  Write-Utf8NoBom -Path $manifestPath -Value $manifest
} elseif ($manifest -notmatch 'android:authorities="\$\{applicationId\}\.fileprovider"' -or $manifest -notmatch 'android:resource="@xml/apk_installer_paths"') {
  throw 'An existing FileProvider uses a different authority or paths resource. Resolve the conflict manually before building.'
}

Write-Host 'ApkInstaller sources copied and Capacitor plugin registration checked.'
