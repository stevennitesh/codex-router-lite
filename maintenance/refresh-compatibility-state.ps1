[CmdletBinding()]
param(
  [switch]$SkipFetch,
  [switch]$SkipTests,
  [switch]$AnalyzeUpstream
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

function Show-RouterUpstreamAnalysis([string]$Baseline, [string]$RemoteRef) {
  $watchedPaths = @(
    "config/openrouter/glm-5.3-flash.json",
    "config/openrouter/glm-5.3-flash-gmicloud.json",
    "src/api-forwarder.mjs",
    "src/catalog.mjs",
    "src/codex-account-usage.mjs",
    "src/compaction-checkpoint.mjs",
    "src/error-translation.mjs",
    "src/file-security.mjs",
    "src/item-lifecycle-normalizer.mjs",
    "src/model-registry.mjs",
    "src/namespace-relay.mjs",
    "src/openai-adapters.mjs",
    "src/rate-limit-headers.mjs",
    "src/reasoning-tag-stripper.mjs",
    "src/responses-websocket.mjs",
    "src/router.mjs",
    "src/search-capability.mjs",
    "src/service-windows.mjs",
    "src/target-integration.mjs",
    "test/glm-5.3-flash.test.mjs"
  )
  Write-Host "Pending Router upstream commits touching retained concerns:"
  $logArguments = @("-C", $repoRoot, "log", "--oneline", "$Baseline..$RemoteRef", "--") + $watchedPaths
  Invoke-Checked "git" $logArguments
  $changedText = Read-Git @("diff", "--name-only", "$Baseline..$RemoteRef")
  $changed = @($changedText -split "`n" | Where-Object { $_ })
  $groups = [ordered]@{
    "Responses and tool lifecycle" = '^src/(?:api-forwarder|router|compaction-checkpoint|item-lifecycle-normalizer|namespace-relay|openai-adapters|error-translation|reasoning-tag-stripper|responses-websocket|target-integration)\.mjs$'
    "Native catalog and authentication" = '^src/(?:catalog|codex-account-usage|model-registry|file-security)\.mjs$'
    "Windows service" = '^src/service-windows\.mjs$'
    "GLM and routed models" = '^(?:config/openrouter/glm-5\.3-flash(?:-gmicloud)?\.json|test/glm-5\.3-flash\.test\.mjs|src/(?:rate-limit-headers|search-capability)\.mjs)$'
  }
  foreach ($entry in $groups.GetEnumerator()) {
    $matches = @($changed | Where-Object { $_ -match $entry.Value })
    if ($matches.Count) {
      Write-Host "$($entry.Key): $($matches -join ', ')"
    }
  }
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

$routerWatchPath = Join-Path $repoRoot "maintenance\upstream-router.json"
$routerWatch = Get-Content -Raw -LiteralPath $routerWatchPath | ConvertFrom-Json
if ($routerWatch.version -ne 1 -or $routerWatch.repository -notmatch '^https://github\.com/[^/]+/[^/]+(?:\.git)?$' -or
    $routerWatch.branch -notmatch '^[a-zA-Z0-9._/-]+$' -or
    $routerWatch.remoteRef -notmatch '^[a-zA-Z0-9._-]+/[a-zA-Z0-9._/-]+$' -or
    $routerWatch.lastReviewedCommit -notmatch '^[0-9a-f]{40}$') {
  throw "maintenance/upstream-router.json is invalid."
}
& git -C $repoRoot rev-parse --verify --quiet $routerWatch.lastReviewedCommit *> $null
if ($LASTEXITCODE -ne 0) {
  throw "The reviewed Router upstream commit is not available locally: $($routerWatch.lastReviewedCommit)"
}
& git -C $repoRoot rev-parse --verify --quiet $routerWatch.remoteRef *> $null
if ($LASTEXITCODE -ne 0) {
  if ($SkipFetch) {
    throw "The Router upstream ref is not available locally. Run again without -SkipFetch: $($routerWatch.remoteRef)"
  }
  $trackingRef = "refs/remotes/$($routerWatch.remoteRef)"
  Invoke-Checked "git" @(
    "-C", $repoRoot, "fetch", "--no-tags", $routerWatch.repository,
    "$($routerWatch.branch):$trackingRef"
  )
}
& git -C $repoRoot merge-base --is-ancestor $routerWatch.lastReviewedCommit $routerWatch.remoteRef
if ($LASTEXITCODE -ne 0) {
  throw "The reviewed Router upstream commit is not an ancestor of $($routerWatch.remoteRef)."
}
$pendingRouterUpstream = [int](Read-Git @("rev-list", "--count", "$($routerWatch.lastReviewedCommit)..$($routerWatch.remoteRef)"))
Write-Host "Router upstream review baseline: $($routerWatch.lastReviewedCommit)"
Write-Host "Router upstream commits pending review: $pendingRouterUpstream"
if ($AnalyzeUpstream -and $pendingRouterUpstream -gt 0) {
  Show-RouterUpstreamAnalysis $routerWatch.lastReviewedCommit $routerWatch.remoteRef
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
  Write-Host "Codex app mismatch branch:"
  Write-Host "1. Capture the native codex_app tool names and JSON schemas from an ordinary Windows app turn."
  Write-Host "2. Compare that inventory with src/codex-app-tools.mjs; do not infer compatibility from version numbers."
  Write-Host "3. Refresh the native catalog and run the catalog, app-tool, and namespace-relay tests."
  Write-Host "4. Run one native routed tool call through GLM and Switchyard."
  Write-Host "5. Refresh both exact-route v2 proofs only if tool relay or child continuation changed."
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
    if ($AnalyzeUpstream) {
      # GetTempPath ends with a separator, while GetDirectoryName does not.
      # Normalize both sides before enforcing direct-child cleanup.
      $tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([char[]]@('\', '/'))
      $analysisRoot = [IO.Path]::GetFullPath((Join-Path $tempParent "switchyard-upstream-$([Guid]::NewGuid().ToString('N'))"))
      if (-not [string]::Equals([IO.Path]::GetDirectoryName($analysisRoot), $tempParent, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe Switchyard analysis path: $analysisRoot"
      }
      try {
        Invoke-Checked "git" @("clone", "--filter=blob:none", "--no-checkout", $sourceLock.repository, $analysisRoot)
        Invoke-Checked "git" @("-C", $analysisRoot, "checkout", "--detach", $upstreamHead)
        Write-Host "Pending Switchyard upstream commits:"
        Invoke-Checked "git" @("-C", $analysisRoot, "log", "--oneline", "$($sourceLock.commit)..$upstreamHead")
        $patchPath = Join-Path (Join-Path $repoRoot "config\switchyard") $sourceLock.patch
        & git -C $analysisRoot apply --check $patchPath
        if ($LASTEXITCODE -eq 0) {
          Write-Host "The canonical Switchyard patch still applies to upstream HEAD. A rebuild and certification are still required."
        } else {
          Write-Warning "The canonical Switchyard patch conflicts with upstream HEAD. Rebase it deliberately before building."
        }
      } finally {
        if (Test-Path -LiteralPath $analysisRoot -PathType Container) {
          Remove-Item -LiteralPath $analysisRoot -Recurse -Force
        }
      }
    }
  }
}

Write-Step "Result"
if ($snapshotMatches -and $healthClean) {
  Write-Host "Current repository, runtime, catalog, and app-tool snapshot checks passed."
} else {
  Write-Host "Source checks passed, but warnings above still require confirmation before declaring full compatibility."
}
Write-Host "No files, configuration, provider quota, or service state were changed."
