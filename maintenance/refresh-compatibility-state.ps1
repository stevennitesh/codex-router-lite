[CmdletBinding()]
param(
  [switch]$SkipFetch,
  [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))

function Write-Step([string]$Message) {
  Write-Host "`n== $Message =="
}

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command exited with status $LASTEXITCODE."
  }
}

function Read-Git([string[]]$Arguments) {
  $output = & git -C $repoRoot @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed with status $LASTEXITCODE."
  }
  return (@($output) -join "`n").Trim()
}

Set-Location -LiteralPath $repoRoot

Write-Step "Repository state"
Invoke-Checked "git" @("-C", $repoRoot, "status", "--short", "--branch")
Invoke-Checked "git" @("-C", $repoRoot, "remote", "-v")
if (-not $SkipFetch) {
  Write-Step "Refreshing repository heads"
  Invoke-Checked "git" @("-C", $repoRoot, "fetch", "--all", "--prune")
}
$head = Read-Git @("rev-parse", "HEAD")
Write-Host "HEAD $head"
foreach ($remoteRef in @("origin/main", "upstream/main")) {
  & git -C $repoRoot rev-parse --verify --quiet $remoteRef *> $null
  if ($LASTEXITCODE -eq 0) {
    $remoteHead = Read-Git @("rev-parse", $remoteRef)
    $distance = Read-Git @("rev-list", "--left-right", "--count", "HEAD...$remoteRef")
    Write-Host "$remoteRef $remoteHead (HEAD/remote distance: $distance)"
  }
}

Write-Step "Windows Codex identity"
$codexBinary = (& node --input-type=module -e "import {findCodexBinary} from './src/codex-binary.mjs'; process.stdout.write(findCodexBinary() || '')").Trim()
if ($LASTEXITCODE -ne 0 -or -not $codexBinary) {
  throw "The current Codex executable could not be resolved."
}
$codexVersion = (& $codexBinary --version).Trim()
if ($LASTEXITCODE -ne 0) {
  throw "The current Codex executable did not report its version."
}
Write-Host "Codex executable: $codexBinary"
Write-Host "Codex version: $codexVersion"
$signature = Get-AuthenticodeSignature -LiteralPath $codexBinary
Write-Host "Codex signature: $($signature.Status)"
if ($signature.Status -ne "Valid") {
  throw "The current Codex executable does not have a valid Authenticode signature."
}
if ($signature.SignerCertificate.Subject -notmatch "OpenAI") {
  throw "The current Codex executable was not signed by OpenAI."
}

$appPackage = Get-AppxPackage -Name "OpenAI.Codex" | Sort-Object Version -Descending | Select-Object -First 1
if ($appPackage) {
  $appVersion = [string]$appPackage.Version
  Write-Host "Windows app package: $($appPackage.PackageFullName)"
} else {
  $appVersion = $null
  Write-Warning "The current process could not read the OpenAI Codex Appx package identity."
}

$snapshotJson = & node --input-type=module -e "import {CODEX_APP_TOOL_SNAPSHOT as s} from './src/codex-app-tools.mjs'; process.stdout.write(JSON.stringify(s))"
if ($LASTEXITCODE -ne 0) {
  throw "The checked-in Codex app tool snapshot metadata could not be read."
}
$snapshot = $snapshotJson | ConvertFrom-Json
Write-Host "App-tool snapshot: Windows $($snapshot.windowsAppVersion), $($snapshot.codexVersion), captured $($snapshot.capturedAt)"
$snapshotMatches = $appVersion -and $appVersion -eq [string]$snapshot.windowsAppVersion -and $codexVersion -eq [string]$snapshot.codexVersion
if (-not $snapshotMatches) {
  Write-Warning "The installed Codex build differs from the app-tool snapshot. Capture the live app tool registry from an ordinary Windows app turn before declaring compatibility."
}

Write-Step "Current Codex catalog compatibility"
Invoke-Checked "node" @("scripts/check-codex-catalog-compat.mjs", $codexBinary)

Write-Step "Router runtime health"
$doctorJson = & node src/doctor.mjs --json
if ($LASTEXITCODE -ne 0) {
  throw "Router Doctor reported a failed compatibility check."
}
$doctorChecks = $doctorJson | ConvertFrom-Json
foreach ($check in $doctorChecks) {
  Write-Host "[$($check.status)] $($check.name): $($check.detail)"
}
$healthClean = -not @($doctorChecks | Where-Object { $_.status -ne "ok" }).Count
if (-not $healthClean) {
  Write-Warning "Router health is not fully confirmed in this process. Re-run under the interactive Windows user if protected state was unavailable."
}

if (-not $SkipTests) {
  Write-Step "Retained product checks"
  Invoke-Checked "npm" @("run", "check")
  Invoke-Checked "npm" @("test")
}

Write-Step "Switchyard upstream signal"
$sourceLockPath = Join-Path $repoRoot "config\switchyard\source.lock"
$sourceLock = Get-Content -Raw -LiteralPath $sourceLockPath | ConvertFrom-Json
$remoteLine = @(& git ls-remote $sourceLock.repository HEAD)
if ($LASTEXITCODE -ne 0 -or -not $remoteLine) {
  Write-Warning "Switchyard upstream HEAD could not be read. The locked commit remains $($sourceLock.commit)."
} else {
  $upstreamHead = ($remoteLine[0] -split "\s+")[0]
  Write-Host "Locked Switchyard commit: $($sourceLock.commit)"
  Write-Host "Switchyard upstream HEAD: $upstreamHead"
  if ($upstreamHead -ne $sourceLock.commit) {
    Write-Host "Review is available. Do not update the pin until the upstream diff and canonical patch pass the Switchyard runbook."
  }
}

Write-Step "Result"
if ($snapshotMatches -and $healthClean) {
  Write-Host "Current repository, runtime, catalog, and app-tool snapshot checks passed."
} else {
  Write-Host "Source checks passed, but warnings above still require confirmation before declaring full compatibility."
}
Write-Host "No files, configuration, provider quota, or service state were changed."
