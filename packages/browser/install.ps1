# Install dsh-plugin-browser into a DSH profile.
#
# The package is linked (not copied), so source edits are picked up on the next
# Host restart. Client-side changes do not exist yet; this plugin is Host-only.
#
# Usage:
#   pwsh -File install.ps1 -Profile desktop
#   pwsh -File install.ps1 -Profile desktop -Restart

[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [switch]$Restart
)

$ErrorActionPreference = 'Stop'

$source = $PSScriptRoot
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileRoot = Join-Path $dshHome "profiles\$Profile"
if (-not (Test-Path $profileRoot)) { throw "profile not found: $profileRoot" }

$pkgPath = Join-Path $profileRoot 'package.json'
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$depName = '@local/dsh-plugin-browser'
$depSpec = "link:$($source -replace '\\', '/')"
$bundleName = $depName

# 1. Profile dependency.
if (-not $pkg.dependencies.PSObject.Properties[$depName]) {
  $pkg.dependencies | Add-Member -NotePropertyName $depName -NotePropertyValue $depSpec
  "added dependency: $depName -> $depSpec"
} elseif ($pkg.dependencies.$depName -ne $depSpec) {
  $pkg.dependencies.$depName = $depSpec
  "updated dependency: $depName -> $depSpec"
}

# 2. Bundle composition.
if ($pkg.dsh.profile.bundles -notcontains $bundleName) {
  $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles) + $bundleName
  "added bundle: $bundleName"
}
if (-not $pkg.dsh.profile.patchReload) {
  $pkg.dsh.profile | Add-Member -NotePropertyName patchReload -NotePropertyValue 'live'
  "enabled live patch reload"
}
$json = $pkg | ConvertTo-Json -Depth 20
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($pkgPath, $json, $utf8NoBom)
"profile package.json written: $pkgPath"

# 3. Node_modules junction.
$scope = Join-Path $profileRoot 'node_modules\@local'
New-Item -ItemType Directory -Force -Path $scope | Out-Null
$link = Join-Path $scope 'dsh-plugin-browser'
if (Test-Path $link) { (Get-Item $link).Delete() }
New-Item -ItemType Junction -Path $link -Target $source | Out-Null
"linked: $link -> $source"

# 4. Contract tests from inside the profile so @deepseek-ai/dsh-tools resolves
#    from the shared profile node_modules.
Push-Location $link
try {
  node --preserve-symlinks --preserve-symlinks-main --test `
    'test/policy.test.mjs' 'test/target.test.mjs' 'test/format.test.mjs' `
    'test/plugin.test.mjs' 'test/cordis.test.mjs' 'test/host-schema.test.mjs' 'test/tools.test.mjs'
  if ($LASTEXITCODE -ne 0) { throw "contract tests failed (exit $LASTEXITCODE)" }
} finally {
  Pop-Location
}

if ($Restart) {
  $running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
  if ($running) {
    "stopping $(($running | Measure-Object).Count) DeepSeek Harness process(es)"
    $running | Stop-Process -Force
    Start-Sleep -Seconds 2
  }
  "stopped. Relaunch DeepSeek Harness to load the browser plugin."
}

"done. Restart DeepSeek Harness (or open a new session) so browser_* tools appear."
