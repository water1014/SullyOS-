[CmdletBinding()]
param(
  [string]$WrapperRoot = 'D:\CHICK\CHICK2',
  [switch]$BuildDebugApk
)

$ErrorActionPreference = 'Stop'

$sourceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (-not (Test-Path -LiteralPath $WrapperRoot -PathType Container)) {
  throw "Wrapper project directory does not exist: $WrapperRoot"
}
$wrapperRoot = (Resolve-Path -LiteralPath $WrapperRoot).Path
$sourceDist = Join-Path $sourceRoot 'dist'
$targetDist = Join-Path $wrapperRoot 'dist'

$sourceRootFull = [IO.Path]::GetFullPath($sourceRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
$wrapperRootFull = [IO.Path]::GetFullPath($wrapperRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
if ([string]::Equals($sourceRootFull, $wrapperRootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'WrapperRoot points to the SullyOS source repository itself. Refusing to replace its dist directory.'
}

if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'node_modules\vite\bin\vite.js'))) {
  throw 'Source dependencies are missing. Run npm/pnpm install in the SullyOS source first.'
}

Write-Host '[1/4] Building the private Capacitor web bundle...'
Push-Location $sourceRoot
try {
  & node 'node_modules\vite\bin\vite.js' build --mode capacitor
  if ($LASTEXITCODE -ne 0) { throw "Vite build failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

if (-not (Test-Path -LiteralPath $targetDist)) {
  New-Item -ItemType Directory -Path $targetDist | Out-Null
}

$sourceDist = (Resolve-Path -LiteralPath $sourceDist).Path
$targetDist = (Resolve-Path -LiteralPath $targetDist).Path
if ([string]::Equals(
  [IO.Path]::GetFullPath($sourceDist),
  [IO.Path]::GetFullPath($targetDist),
  [System.StringComparison]::OrdinalIgnoreCase
)) {
  throw 'Source and wrapper dist directories resolve to the same path. Refusing destructive copy.'
}
$expectedTarget = [IO.Path]::GetFullPath((Join-Path $wrapperRoot 'dist'))
$wrapperPrefix = $wrapperRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if ($targetDist -ne $expectedTarget -or -not $targetDist.StartsWith($wrapperPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to replace an unexpected directory: $targetDist"
}

$sourceBridgeCount = @(Get-ChildItem -LiteralPath (Join-Path $sourceDist 'assets') -Filter 'nativeAmsgPush-*.js').Count
if ($sourceBridgeCount -ne 1) {
  throw "Expected one native AMSG bridge bundle in the source build, found $sourceBridgeCount. Existing wrapper assets were not changed."
}

Write-Host '[2/4] Staging a verified replacement for CHICK2/dist...'
$stagingDist = Join-Path $wrapperRoot 'dist.sullyos-staging'
$backupDist = Join-Path $wrapperRoot 'dist.sullyos-previous'
foreach ($candidatePath in @($stagingDist, $backupDist)) {
  if (Test-Path -LiteralPath $candidatePath) {
    Remove-Item -LiteralPath $candidatePath -Recurse -Force
  }
}
New-Item -ItemType Directory -Path $stagingDist | Out-Null
try {
  Get-ChildItem -LiteralPath $sourceDist -Force | Copy-Item -Destination $stagingDist -Recurse -Force
  $stagedBridgeCount = @(Get-ChildItem -LiteralPath (Join-Path $stagingDist 'assets') -Filter 'nativeAmsgPush-*.js').Count
  if ($stagedBridgeCount -ne 1) {
    throw "Expected one native AMSG bridge bundle in staged output, found $stagedBridgeCount"
  }

  Move-Item -LiteralPath $targetDist -Destination $backupDist
  try {
    Move-Item -LiteralPath $stagingDist -Destination $targetDist
  } catch {
    if (-not (Test-Path -LiteralPath $targetDist) -and (Test-Path -LiteralPath $backupDist)) {
      Move-Item -LiteralPath $backupDist -Destination $targetDist
    }
    throw
  }
  Remove-Item -LiteralPath $backupDist -Recurse -Force
} catch {
  if (Test-Path -LiteralPath $stagingDist) {
    Remove-Item -LiteralPath $stagingDist -Recurse -Force
  }
  throw
}

Write-Host '[3/4] Syncing Capacitor Android plugins and assets...'
& (Join-Path $PSScriptRoot 'install-apk-installer.ps1') -WrapperRoot $wrapperRoot
if ($LASTEXITCODE -ne 0) { throw "ApkInstaller integration failed with exit code $LASTEXITCODE" }

& node (Join-Path $PSScriptRoot 'sync-native-app-name.mjs') $wrapperRoot
if ($LASTEXITCODE -ne 0) { throw "App display name sync failed with exit code $LASTEXITCODE" }
Push-Location $wrapperRoot
try {
  & npx.cmd cap sync android
  if ($LASTEXITCODE -ne 0) { throw "Capacitor sync failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

if (-not $BuildDebugApk) {
  Write-Host 'Capacitor sync complete. APK compilation was intentionally skipped.'
  Write-Host 'Only during the final packaging phase, pass -BuildDebugApk to compile a debug APK.'
  exit 0
}

Write-Host '[4/4] Building the debug APK...'
$gradleDistRoot = Join-Path $env:USERPROFILE '.gradle\wrapper\dists\gradle-8.2.1-all'
$gradleExecutable = Get-ChildItem -LiteralPath $gradleDistRoot -Filter 'gradle.bat' -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -like '*\gradle-8.2.1\bin\gradle.bat' } |
  Select-Object -First 1 -ExpandProperty FullName

$androidRoot = Join-Path $wrapperRoot 'android'
Push-Location $androidRoot
try {
  if ($gradleExecutable) {
    $env:GRADLE_USER_HOME = Join-Path $sourceRoot '.gradle-user-home'
    & $gradleExecutable assembleDebug
  } else {
    & (Join-Path $androidRoot 'gradlew.bat') assembleDebug
  }
  if ($LASTEXITCODE -ne 0) { throw "Android build failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

$apk = Join-Path $androidRoot 'app\build\outputs\apk\debug\app-debug.apk'
if (-not (Test-Path -LiteralPath $apk)) { throw "APK was not generated: $apk" }

$hash = Get-FileHash -LiteralPath $apk -Algorithm SHA256
Write-Host "APK: $apk"
Write-Host "SHA256: $($hash.Hash)"
