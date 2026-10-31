[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{40}$')][string]$ExpectedRouterCommit,
  [Parameter(Mandatory = $true)][string]$CandidateBinary,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedBinarySha256,
  [ValidateRange(1, 3600)][int]$ExitTimeoutSeconds = 1800,
  [switch]$ReopenCodexOnSuccess,
  [switch]$InProcess,
  [string]$ExpectedCandidateSha256,
  [string]$AcceptancePath,
  [string]$NativeCompactionRestorePlan,
  [string]$NativeCompactionRestorePlanSha256
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$helper = Join-Path $PSScriptRoot 'web-runtime-maintenance.mjs'
$candidatePath = [IO.Path]::GetFullPath($CandidateBinary)
$restorationArgs = @()
if ($NativeCompactionRestorePlan -or $NativeCompactionRestorePlanSha256) {
  if (-not [IO.Path]::IsPathRooted($NativeCompactionRestorePlan) -or $NativeCompactionRestorePlanSha256 -cnotmatch '^[a-f0-9]{64}$') {
    throw 'Native compaction restoration requires the absolute protected plan and exact reviewed confirmation SHA-256.'
  }
  $NativeCompactionRestorePlan = [IO.Path]::GetFullPath($NativeCompactionRestorePlan)
  $restorationArgs = @($NativeCompactionRestorePlan, $NativeCompactionRestorePlanSha256)
}
if (-not $InProcess) {
  # Validate the complete candidate while Codex is open, before dispatch/wait.
  $preview = & node $helper plan $ExpectedRouterCommit $candidatePath $ExpectedBinarySha256 @restorationArgs
  if ($LASTEXITCODE -ne 0) { throw 'Web maintenance candidate validation failed; no worker was prepared.' }
  $plan = $preview | ConvertFrom-Json
  $reopen = $null
  if ($ReopenCodexOnSuccess) {
    . (Join-Path $PSScriptRoot 'codex-app-activation.ps1')
    $reopen = Get-CodexMaintenanceReopenIdentity
  }
  . (Join-Path $PSScriptRoot 'deployment-runner.ps1')
  Start-IndependentDeployment -ScriptPath $PSCommandPath -RepoRoot $repoRoot -RequireAcceptance -AcceptanceKind 'web-runtime-maintenance' -ReopenCodex $reopen -Parameters @{
    ExpectedRouterCommit = $ExpectedRouterCommit; CandidateBinary = $candidatePath; ExpectedBinarySha256 = $ExpectedBinarySha256.ToLowerInvariant()
    ExitTimeoutSeconds = $ExitTimeoutSeconds; ExpectedCandidateSha256 = $plan.candidateSha256
    NativeCompactionRestorePlan = $NativeCompactionRestorePlan; NativeCompactionRestorePlanSha256 = $NativeCompactionRestorePlanSha256
  }
  return
}
if ($ExpectedCandidateSha256 -notmatch '^[a-f0-9]{64}$' -or -not $AcceptancePath) { throw 'Independent Web maintenance requires its protected candidate and acceptance request.' }
& node $helper run $ExpectedRouterCommit $candidatePath $ExpectedBinarySha256 $ExpectedCandidateSha256 $ExitTimeoutSeconds $AcceptancePath @restorationArgs
if ($LASTEXITCODE -ne 0) { throw "Web runtime maintenance failed with status $LASTEXITCODE; inspect the protected deployment result and log." }
