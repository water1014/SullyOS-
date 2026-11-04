[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$WrapperRoot
)

$ErrorActionPreference = 'Stop'
$androidRoot = Join-Path $WrapperRoot 'android'
$appRoot = Join-Path $androidRoot 'app'
$javaSource = Join-Path $PSScriptRoot '..\native\android\secure-storage\SecureStoragePlugin.java'

if (-not (Test-Path -LiteralPath $appRoot)) { throw "Android app module not found: $appRoot" }
if (-not (Test-Path -LiteralPath $javaSource)) { throw "SecureStorage Java source missing: $javaSource" }

$mainActivity = Get-ChildItem -LiteralPath $appRoot -Filter 'MainActivity.java' -Recurse -File |
  Select-Object -First 1
if (-not $mainActivity) { throw 'MainActivity.java not found. Refusing to guess the Android package path.' }

$activityContent = Get-Content -LiteralPath $mainActivity.FullName -Raw
if ($activityContent -notmatch 'package\s+com\.aetheros\.simulator\s*;') {
  throw 'MainActivity package is not com.aetheros.simulator. Review the wrapper identity before installing SecureStorage.'
}

Copy-Item -LiteralPath $javaSource -Destination (Join-Path $mainActivity.DirectoryName 'SecureStoragePlugin.java') -Force

if ($activityContent -notmatch 'import\s+com\.aetheros\.simulator\.SecureStoragePlugin\s*;') {
  $activityContent = [regex]::Replace(
    $activityContent,
    '(?m)^(package\s+[^;]+;)',
    '$1' + [Environment]::NewLine + 'import com.aetheros.simulator.SecureStoragePlugin;',
    1
  )
}
if ($activityContent -notmatch 'registerPlugin\(SecureStoragePlugin\.class\)') {
  if ($activityContent -match 'public\s+void\s+onCreate\s*\(Bundle\s+savedInstanceState\)\s*\{') {
    $activityContent = [regex]::Replace(
      $activityContent,
      '(public\s+void\s+onCreate\s*\(Bundle\s+savedInstanceState\)\s*\{)',
      '$1' + [Environment]::NewLine + '        registerPlugin(SecureStoragePlugin.class);',
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
        registerPlugin(SecureStoragePlugin.class);
        super.onCreate(savedInstanceState);
    }

'@
    $activityContent = $activityContent.Insert($lastBrace, $method)
  }
}

$encoding = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($mainActivity.FullName, $activityContent, $encoding)
Write-Host 'SecureStorage sources copied and Capacitor plugin registration checked.'
