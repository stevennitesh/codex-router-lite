[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory = $true)]
  [string]$CandidateBinary,
  [string]$CandidateRoutes,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedBinarySha256,
  [string]$ExpectedRoutesSha256,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedRouterCommit,
  [string]$RollbackRouterRoot,
  [string]$ExpectedRollbackRouterCommit,
  [string]$RepoDir = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"
$repoRoot = [IO.Path]::GetFullPath($RepoDir)
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
$stateRoot = [IO.Path]::GetFullPath((Join-Path $codexHome "codex-router"))
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $codexHome "switchyard"))
$candidateBinary = [IO.Path]::GetFullPath($CandidateBinary)
$installedRoutes = [IO.Path]::GetFullPath((Join-Path $runtimeRoot "routes.toml"))
$candidateRoutes = if ([string]::IsNullOrWhiteSpace($CandidateRoutes)) {
  $installedRoutes
} else {
  [IO.Path]::GetFullPath($CandidateRoutes)
}
$expectedBinaryHash = $ExpectedBinarySha256.ToLowerInvariant()
$expectedRouterCommit = $ExpectedRouterCommit.ToLowerInvariant()
$installManifestPath = Join-Path $stateRoot "install-manifest.json"
if (-not (Test-Path -LiteralPath $installManifestPath -PathType Leaf)) {
  throw "Installed Router manifest is missing at $installManifestPath."
}
$installManifest = Get-Content -Raw -LiteralPath $installManifestPath | ConvertFrom-Json
$installedRouterCommit = "$($installManifest.current.commit)".Trim().ToLowerInvariant()
if ($installedRouterCommit -notmatch '^[0-9a-f]{40}$') {
  throw "Installed Router manifest does not contain a valid current commit."
}
if (
  -not [string]::IsNullOrWhiteSpace($ExpectedRollbackRouterCommit) -and
  $ExpectedRollbackRouterCommit.ToLowerInvariant() -ne $installedRouterCommit
) {
  throw "Rollback Router commit must match the installed Router manifest commit $installedRouterCommit."
}
$expectedRollbackCommit = $installedRouterCommit
$autoRollbackRouterRoot = [string]::IsNullOrWhiteSpace($RollbackRouterRoot)
$rollbackRouterRoot = if ($autoRollbackRouterRoot) {
  [IO.Path]::GetFullPath((Join-Path $repoRoot "generated\router-rollback-$($expectedRollbackCommit.Substring(0, 8))"))
} else {
  [IO.Path]::GetFullPath($RollbackRouterRoot)
}

if ([string]::IsNullOrWhiteSpace($ExpectedRoutesSha256)) {
  if (-not [string]::Equals($candidateRoutes, $installedRoutes, [StringComparison]::OrdinalIgnoreCase)) {
    throw "ExpectedRoutesSha256 is required when CandidateRoutes is not the installed private route file."
  }
  $provenancePath = Join-Path $runtimeRoot "provenance.json"
  if (-not (Test-Path -LiteralPath $provenancePath -PathType Leaf)) {
    throw "Installed Switchyard provenance is missing at $provenancePath."
  }
  $installedProvenance = Get-Content -Raw -LiteralPath $provenancePath | ConvertFrom-Json
  $ExpectedRoutesSha256 = "$($installedProvenance.routesSha256)".Trim()
}
$expectedRoutesHash = $ExpectedRoutesSha256.ToLowerInvariant()
if ($expectedRoutesHash -notmatch '^[0-9a-f]{64}$') {
  throw "Expected Switchyard routes SHA-256 is invalid."
}
$runtimeFiles = @("switchyard-server.exe", "routes.toml", "SOURCE_COMMIT", "provenance.json")
$stageRoot = Join-Path $runtimeRoot ".candidate-$([Guid]::NewGuid().ToString('N'))"
$rollbackRoot = Join-Path $runtimeRoot ".rollback-$([Guid]::NewGuid().ToString('N'))"
$keepRollback = $false
$activationStarted = $false

function Get-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  try {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
      return ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    } finally {
      $hasher.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Assert-FileHash([string]$Path, [string]$Expected, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label is missing at $Path."
  }
  $actual = Get-Sha256 $Path
  if ($actual -ne $Expected.ToLowerInvariant()) {
    throw "$Label hash mismatch: expected $Expected, got $actual."
  }
}

function Assert-CheckoutIdentity([string]$Root, [string]$ExpectedCommit, [string]$Label) {
  $commitOutput = & git -C $Root rev-parse HEAD
  if ($LASTEXITCODE -ne 0 -or $null -eq $commitOutput) {
    throw "$Label is not a readable Git checkout."
  }
  $commit = "$commitOutput".Trim().ToLowerInvariant()
  if ($commit -ne $ExpectedCommit.ToLowerInvariant()) {
    throw "$Label does not match commit $ExpectedCommit."
  }
  $changes = @(& git -C $Root status --porcelain --untracked-files=all)
  if ($LASTEXITCODE -ne 0 -or $changes.Count -ne 0) {
    throw "$Label is not an exact clean checkout."
  }
}

function Ensure-RollbackRouterCheckout {
  if (Test-Path -LiteralPath $rollbackRouterRoot -PathType Container) {
    Assert-CheckoutIdentity $rollbackRouterRoot $expectedRollbackCommit "Rollback Router checkout"
    return
  }
  if (-not $autoRollbackRouterRoot) {
    throw "Explicit rollback Router checkout is missing at $rollbackRouterRoot."
  }
  if ($WhatIfPreference) {
    throw "Generated rollback checkout is missing; run without WhatIf only when deployment is authorized."
  }
  $expectedParent = [IO.Path]::GetFullPath((Join-Path $repoRoot "generated"))
  if (-not [string]::Equals(
    [IO.Path]::GetDirectoryName($rollbackRouterRoot),
    $expectedParent,
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw "Unsafe generated rollback checkout path: $rollbackRouterRoot"
  }
  New-Item -ItemType Directory -Force -Path $expectedParent | Out-Null
  & git -C $repoRoot worktree add --detach $rollbackRouterRoot $expectedRollbackCommit
  if ($LASTEXITCODE -ne 0) {
    throw "Could not create the rollback Router checkout at commit $expectedRollbackCommit."
  }
  Assert-CheckoutIdentity $rollbackRouterRoot $expectedRollbackCommit "Generated rollback Router checkout"
}

function Invoke-NodeJson([string]$Root, [string[]]$Arguments, [string]$Label) {
  $output = (& node @Arguments | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "$Label failed from $Root." }
  try { return $output | ConvertFrom-Json } catch { throw "$Label returned invalid JSON." }
}

function Invoke-RouterService([string]$Root, [string]$Command) {
  & node (Join-Path $Root "src\service.mjs") $Command
  if ($LASTEXITCODE -ne 0) { throw "Router service $Command failed from $Root." }
}

function Invoke-RouterInstall([string]$Root) {
  & (Join-Path $Root "install.ps1") -CheckoutInstall -Target codex
  if ($LASTEXITCODE -ne 0) { throw "Router install failed from $Root." }
}

function Get-SubagentPublicationPlan {
  $status = Invoke-NodeJson $repoRoot @(
    (Join-Path $repoRoot "src\control.mjs"), "subagents", "status"
  ) "Subagent publication status"
  $picker = Invoke-NodeJson $repoRoot @(
    (Join-Path $repoRoot "src\control.mjs"), "picker", "status"
  ) "Model picker status"
  $certified = @($status.routes | Where-Object { $_.multiAgentVersion -eq "v2" } | ForEach-Object { $_.slug })
  $enabled = @($status.settings.enabled)
  $disabled = @($status.settings.disabled)
  $hidden = @($picker.hidden)
  $expected = if ($status.settings.mode -eq "selected") {
    @($certified | Where-Object { $_ -in $enabled -and $_ -notin $disabled -and $_ -notin $hidden })
  } else {
    @($certified | Where-Object { $_ -notin $disabled -and $_ -notin $hidden })
  }
  return [pscustomobject]@{
    mode = $status.settings.mode
    certified = $certified
    expected = $expected
    ignoredEnabled = @($enabled | Where-Object { $_ -notin $certified })
    hiddenCertified = @($hidden | Where-Object { $_ -in $certified })
  }
}

function Prepare-RollbackRouter([string]$Root) {
  # Rollback must not begin by downloading dependencies while the Router is
  # already down. Prepare the exact rollback checkout against an isolated
  # state directory before activation, then discard that generated state. The
  # checkout's ignored node_modules and .venv remain ready for a fast install.
  $missingSteps = @()
  foreach ($step in @("node-deps", "python-deps")) {
    $status = (& node (Join-Path $Root "src\install-plan.mjs") status $step | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $status -ne "skip") { $missingSteps += $step }
  }
  if (-not $missingSteps.Count) { return }
  # A WhatIf run must not create the preparation tree or let PowerShell's
  # inherited WhatIfPreference suppress environment and directory cleanup.
  if ($WhatIfPreference) {
    throw "Rollback Router dependencies need preparation before WhatIf: $($missingSteps -join ', ')."
  }
  $prepareRoot = [IO.Path]::GetFullPath((
    Join-Path $Root "generated\rollback-prepare-$([Guid]::NewGuid().ToString('N'))"
  ))
  $expectedParent = [IO.Path]::GetFullPath((Join-Path $Root "generated"))
  if (-not [string]::Equals(
    [IO.Path]::GetDirectoryName($prepareRoot),
    $expectedParent,
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw "Unsafe rollback preparation path: $prepareRoot"
  }
  $savedModelState = $env:MODEL_ROUTER_STATE_DIR
  $hadModelState = $null -ne (Get-Item Env:\MODEL_ROUTER_STATE_DIR -ErrorAction SilentlyContinue)
  $savedCodexState = $env:CODEX_ROUTER_STATE_DIR
  $hadCodexState = $null -ne (Get-Item Env:\CODEX_ROUTER_STATE_DIR -ErrorAction SilentlyContinue)
  try {
    $env:MODEL_ROUTER_STATE_DIR = $prepareRoot
    $env:CODEX_ROUTER_STATE_DIR = $prepareRoot
    & (Join-Path $Root "install.ps1") -CheckoutInstall -PrepareOnly -Target codex
    if ($LASTEXITCODE -ne 0) { throw "Rollback Router dependency preparation failed from $Root." }
  } finally {
    if ($hadModelState) { $env:MODEL_ROUTER_STATE_DIR = $savedModelState }
    else { Remove-Item Env:\MODEL_ROUTER_STATE_DIR -ErrorAction SilentlyContinue }
    if ($hadCodexState) { $env:CODEX_ROUTER_STATE_DIR = $savedCodexState }
    else { Remove-Item Env:\CODEX_ROUTER_STATE_DIR -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $prepareRoot -PathType Container) {
      Remove-Item -LiteralPath $prepareRoot -Recurse -Force
    }
  }
  foreach ($step in $missingSteps) {
    $status = (& node (Join-Path $Root "src\install-plan.mjs") status $step | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $status -ne "skip") {
      throw "Rollback Router $step is not ready in $Root."
    }
  }
}

function Resolve-RunningRouterRoot([string[]]$AllowedRoots) {
  $stateRoot = Join-Path $codexHome "codex-router"
  $processState = Get-Content -Raw -LiteralPath (Join-Path $stateRoot "service-process.json") | ConvertFrom-Json
  $runningRoot = [IO.Path]::GetFullPath($processState.sourceRoot)
  foreach ($allowedRoot in $AllowedRoots) {
    $resolved = [IO.Path]::GetFullPath($allowedRoot)
    if ([string]::Equals($runningRoot, $resolved, [StringComparison]::OrdinalIgnoreCase)) {
      return $resolved
    }
  }
  throw "The running Router source root is not an approved candidate or rollback checkout: $runningRoot."
}

function Assert-RouterHealth([string]$Root, [string]$ExpectedCommit) {
  & node (Join-Path $Root "src\doctor.mjs") | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Router Doctor failed from $Root." }
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:4202/health" -TimeoutSec 5
  if ($health.ok -ne $true -or @($health.degraded).Count -ne 0) {
    throw "Router health is not clean."
  }
  $status = Invoke-NodeJson $Root @((Join-Path $Root "src\service.mjs"), "status") "Router status"
  if ($status.installed -ne $true -or $status.loaded -ne $true -or $status.state -ne "running") {
    throw "Router task identity is not one running managed generation."
  }
  $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
  $stateRoot = Join-Path $codexHome "codex-router"
  $processState = Get-Content -Raw -LiteralPath (Join-Path $stateRoot "service-process.json") | ConvertFrom-Json
  if (-not [string]::Equals(
    [IO.Path]::GetFullPath($processState.sourceRoot),
    [IO.Path]::GetFullPath($Root),
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw "Router process source root does not match $Root."
  }
  $manifest = Get-Content -Raw -LiteralPath (Join-Path $stateRoot "install-manifest.json") | ConvertFrom-Json
  if ($manifest.current.commit -ne $ExpectedCommit) {
    throw "Router install manifest does not match commit $ExpectedCommit."
  }
}

function Assert-SwitchyardHealth {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:4000/health" -TimeoutSec 5
  if ($health.status -ne "ok" -and $health.ok -ne $true) {
    throw "Switchyard health is not clean."
  }
}

function Assert-CodexCatalog([string]$Root) {
  $stateRoot = Join-Path $codexHome "codex-router"
  $catalogPath = Join-Path $stateRoot "merged-models.json"
  $catalog = Get-Content -Raw -LiteralPath $catalogPath | ConvertFrom-Json
  if ($null -eq $catalog.models -or @($catalog.models).Count -eq 0) {
    throw "The installed merged Codex catalog is empty or invalid."
  }
  $module = ([Uri](Join-Path $Root "src\codex-binary.mjs")).AbsoluteUri
  $program = "const { findCodexBinary } = await import(process.argv[1]); process.stdout.write(findCodexBinary() || '');"
  $codexBinary = (& node --input-type=module -e $program $module | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $codexBinary) { throw "The installed Codex binary was not found." }
  & node (Join-Path $Root "scripts\check-codex-catalog-compat.mjs") $codexBinary --catalog $catalogPath
  if ($LASTEXITCODE -ne 0) { throw "The installed Codex catalog compatibility check failed." }
}

function Assert-ProtectedSwitchyardEndpoint([string]$Path) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:4000" + $Path) -TimeoutSec 5 | Out-Null
    throw "Switchyard $Path accepted a request without its capability."
  } catch {
    if (-not $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 401) { throw }
  }
}

function Protect-PrivateFile([string]$Path) {
  $module = ([Uri](Join-Path $repoRoot "src\file-security.mjs")).AbsoluteUri
  $program = "const { protectPrivateFile } = await import(process.argv[1]); protectPrivateFile(process.argv[2]);"
  & node --input-type=module -e $program $module $Path
  if ($LASTEXITCODE -ne 0) { throw "Failed to protect private file $Path." }
}

function Copy-RuntimeFile([string]$FromRoot, [string]$ToRoot, [string]$Name) {
  Copy-Item -LiteralPath (Join-Path $FromRoot $Name) -Destination (Join-Path $ToRoot $Name) -Force
}

function Restore-Switchyard([Collections.Generic.HashSet[string]]$Existing) {
  foreach ($name in $runtimeFiles) {
    $target = Join-Path $runtimeRoot $name
    if ($Existing.Contains($name)) {
      Copy-RuntimeFile $rollbackRoot $runtimeRoot $name
      if ($name -eq "routes.toml") { Protect-PrivateFile $target }
    } elseif (Test-Path -LiteralPath $target -PathType Leaf) {
      Remove-Item -LiteralPath $target -Force
    }
  }
}

foreach ($path in @(
  (Join-Path $repoRoot "install.ps1"),
  (Join-Path $repoRoot "src\config-manager.mjs"),
  $candidateBinary,
  $candidateRoutes
)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Required deployment input is missing: $path"
  }
}

foreach ($name in @(
  "CODEX_ROUTER_SWITCHYARD_ROOT",
  "CODEX_ROUTER_SWITCHYARD_BIN",
  "CODEX_ROUTER_SWITCHYARD_CONFIG",
  "CODEX_ROUTER_SWITCHYARD_BASE_URL"
)) {
  if (Test-Path -LiteralPath "Env:\$name") {
    throw "Switchyard deployment refuses the runtime override $name; remove it and verify the default managed runtime first."
  }
}
Assert-CheckoutIdentity $repoRoot $expectedRouterCommit "Router candidate checkout"
$routerCommit = $expectedRouterCommit
& git -C $repoRoot merge-base --is-ancestor $expectedRollbackCommit $expectedRouterCommit
if ($LASTEXITCODE -ne 0) { throw "Rollback commit is not an ancestor of the Router candidate." }
if (@(Get-ChildItem -LiteralPath $runtimeRoot -Directory -Force -Filter ".candidate-*" -ErrorAction SilentlyContinue).Count) {
  throw "A Switchyard candidate staging directory already exists."
}
if (@(Get-ChildItem -LiteralPath $runtimeRoot -Directory -Force -Filter ".rollback-*" -ErrorAction SilentlyContinue).Count) {
  throw "A Switchyard rollback directory already exists; resolve it before deploying another candidate."
}

$lock = Get-Content -Raw -LiteralPath (Join-Path $repoRoot "config\switchyard\source.lock") | ConvertFrom-Json
$patchPath = Join-Path (Join-Path $repoRoot "config\switchyard") $lock.patch
Assert-FileHash $patchPath $lock.patchSha256 "Switchyard patch"
Assert-FileHash $candidateBinary $expectedBinaryHash "Switchyard candidate binary"
Assert-FileHash $candidateRoutes $expectedRoutesHash "Switchyard candidate routes"
& $candidateBinary --config $candidateRoutes --dry-run
if ($LASTEXITCODE -ne 0) { throw "Switchyard candidate dry-run failed." }

& node (Join-Path $repoRoot "src\config-manager.mjs") validate-enable | Out-Host
if ($LASTEXITCODE -ne 0) { throw "Codex configuration cannot accept the Router candidate." }
Ensure-RollbackRouterCheckout
Assert-CheckoutIdentity $rollbackRouterRoot $expectedRollbackCommit "Rollback Router checkout"
if (-not (Test-Path -LiteralPath (Join-Path $rollbackRouterRoot "install.ps1") -PathType Leaf)) {
  throw "Rollback Router checkout has no installer."
}
$runningRouterRoot = Resolve-RunningRouterRoot @($repoRoot, $rollbackRouterRoot)
Assert-RouterHealth $runningRouterRoot $expectedRollbackCommit
Assert-SwitchyardHealth
$subagentPlan = Get-SubagentPublicationPlan
$preflight = [ordered]@{
  candidateRouterCommit = $expectedRouterCommit
  runningRouterCommit = $expectedRollbackCommit
  rollbackRouterCommit = $expectedRollbackCommit
  runningRouterRoot = $runningRouterRoot
  subagentMode = $subagentPlan.mode
  certifiedV2Routes = @($subagentPlan.certified)
  expectedPublishedV2Agents = @($subagentPlan.expected)
  ignoredEnabledRoutes = @($subagentPlan.ignoredEnabled)
  hiddenCertifiedRoutes = @($subagentPlan.hiddenCertified)
}
Write-Host "Deployment preflight: $($preflight | ConvertTo-Json -Compress)"
if (@($subagentPlan.certified).Count -and -not @($subagentPlan.expected).Count) {
  Write-Warning "Local subagent settings will publish no routed v2 agents. Fix the selected allowlist before certification."
}

Prepare-RollbackRouter $rollbackRouterRoot
Assert-CheckoutIdentity $rollbackRouterRoot $expectedRollbackCommit "Prepared rollback Router checkout"

if (-not $PSCmdlet.ShouldProcess($runtimeRoot, "deploy the Router and Switchyard candidate")) { return }

$existing = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
try {
  New-Item -ItemType Directory -Force -Path $stageRoot, $rollbackRoot | Out-Null
  Copy-Item -LiteralPath $candidateBinary -Destination (Join-Path $stageRoot "switchyard-server.exe") -Force
  Copy-Item -LiteralPath $candidateRoutes -Destination (Join-Path $stageRoot "routes.toml") -Force
  Protect-PrivateFile (Join-Path $stageRoot "routes.toml")
  Assert-FileHash (Join-Path $stageRoot "switchyard-server.exe") $expectedBinaryHash "Staged Switchyard binary"
  Assert-FileHash (Join-Path $stageRoot "routes.toml") $expectedRoutesHash "Staged Switchyard routes"
  foreach ($name in $runtimeFiles) {
    if (Test-Path -LiteralPath (Join-Path $runtimeRoot $name) -PathType Leaf) {
      [void]$existing.Add($name)
      Copy-RuntimeFile $runtimeRoot $rollbackRoot $name
      if ($name -eq "routes.toml") { Protect-PrivateFile (Join-Path $rollbackRoot $name) }
    }
  }
  @{
    version = 1
    previousRouterCommit = $expectedRollbackCommit
    previousRouterRoot = $runningRouterRoot
    rollbackRouterRoot = $rollbackRouterRoot
    files = @($existing)
    createdAt = (Get-Date).ToUniversalTime().ToString("o")
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $rollbackRoot "rollback.json") -Encoding UTF8

  try {
    # Canonicalize the managed block while the known-good service is still up.
    # If this write fails, the transaction aborts before any process stops.
    & node (Join-Path $repoRoot "src\config-manager.mjs") enable | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Codex configuration update failed before restart." }

    Assert-CheckoutIdentity $repoRoot $expectedRouterCommit "Router candidate checkout"
    $activationStarted = $true
    Invoke-RouterService $runningRouterRoot "stop"
    Copy-RuntimeFile $stageRoot $runtimeRoot "switchyard-server.exe"
    Copy-RuntimeFile $stageRoot $runtimeRoot "routes.toml"
    Protect-PrivateFile (Join-Path $runtimeRoot "routes.toml")
    "$($lock.commit) + local patch $($lock.patchSha256.Substring(0, 12))" |
      Set-Content -LiteralPath (Join-Path $runtimeRoot "SOURCE_COMMIT") -Encoding ASCII
    @{
      version = 1
      upstreamCommit = $lock.commit
      patchSha256 = $lock.patchSha256.ToLowerInvariant()
      binarySha256 = $expectedBinaryHash
      routesSha256 = $expectedRoutesHash
      routerCommit = $routerCommit
      deployedAt = (Get-Date).ToUniversalTime().ToString("o")
    } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $runtimeRoot "provenance.json") -Encoding UTF8

    Invoke-RouterInstall $repoRoot
    Assert-FileHash (Join-Path $runtimeRoot "switchyard-server.exe") $expectedBinaryHash "Installed Switchyard binary"
    Assert-FileHash (Join-Path $runtimeRoot "routes.toml") $expectedRoutesHash "Installed Switchyard routes"
    Assert-RouterHealth $repoRoot $routerCommit
    Assert-SwitchyardHealth
    foreach ($path in @("/v1/models", "/v1/decision")) { Assert-ProtectedSwitchyardEndpoint $path }
    Assert-CodexCatalog $repoRoot
    Assert-CheckoutIdentity $repoRoot $expectedRouterCommit "Running Router candidate checkout"
    $provenance = Get-Content -Raw -LiteralPath (Join-Path $runtimeRoot "provenance.json") | ConvertFrom-Json
    if (
      $provenance.upstreamCommit -ne $lock.commit -or
      $provenance.patchSha256 -ne $lock.patchSha256.ToLowerInvariant() -or
      $provenance.binarySha256 -ne $expectedBinaryHash -or
      $provenance.routesSha256 -ne $expectedRoutesHash -or
      $provenance.routerCommit -ne $routerCommit
    ) {
      throw "Installed Switchyard provenance does not match the candidate."
    }
    $keepRollback = $true
    [pscustomobject]@{
      deployed = $true
      routerCommit = $routerCommit
      switchyardCommit = $lock.commit
      switchyardBinarySha256 = $expectedBinaryHash
      switchyardRoutesSha256 = $expectedRoutesHash
      rollbackRoot = $rollbackRoot
      rollbackRouterRoot = $rollbackRouterRoot
    } | ConvertTo-Json -Depth 3
  } catch {
    $deploymentError = $_
    if (-not $activationStarted) {
      throw "Candidate deployment aborted before the running service changed: $($deploymentError.Exception.Message)"
    }
    try {
      try { Invoke-RouterService $repoRoot "stop" } catch {}
      Restore-Switchyard $existing
      Assert-CheckoutIdentity $rollbackRouterRoot $expectedRollbackCommit "Rollback Router checkout"
      Invoke-RouterInstall $rollbackRouterRoot
      Assert-RouterHealth $rollbackRouterRoot $expectedRollbackCommit
      Assert-SwitchyardHealth
      Assert-CheckoutIdentity $rollbackRouterRoot $expectedRollbackCommit "Running rollback Router checkout"
      $keepRollback = $true
    } catch {
      $keepRollback = $true
      throw "Candidate deployment failed ($($deploymentError.Exception.Message)) and rollback failed ($($_.Exception.Message)). Recovery files remain at $rollbackRoot."
    }
    throw "Candidate deployment failed; the exact previous Router and Switchyard generation was restored: $($deploymentError.Exception.Message)"
  }
} finally {
  if (Test-Path -LiteralPath $stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force }
  if (-not $keepRollback -and (Test-Path -LiteralPath $rollbackRoot)) {
    Remove-Item -LiteralPath $rollbackRoot -Recurse -Force
  }
}
