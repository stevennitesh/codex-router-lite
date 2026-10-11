param([string]$CodeRoot, [string]$FixtureRoot, [switch]$Preview, [string]$Mode = "archive", [string]$Case)
$ErrorActionPreference = "Stop"
. (Join-Path $CodeRoot "maintenance/deployment-json.ps1")
. (Join-Path $CodeRoot "maintenance/switchyard-recovery.ps1")
if ($Mode -ne "archive") {
  $tokens = $null; $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $CodeRoot "maintenance/deploy-switchyard-candidate.ps1"), [ref]$tokens, [ref]$errors)
  if ($errors.Count) { throw "Production deployment parse failed." }
  foreach ($name in @("Copy-RuntimeFile", "Restore-Switchyard", "Resolve-LiveRouterRoot", "Assert-LoopbackOffline", "Stop-RouterGeneration")) {
    $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    Invoke-Expression $function.Extent.Text
  }
  $runtimeRoot = Join-Path $FixtureRoot "runtime"
  $rollbackRoot = Join-Path $FixtureRoot "snapshot"
  $repoRoot = $CodeRoot
  $rollbackRouterRoot = Join-Path $FixtureRoot "previous"
  $runtimeFiles = $SwitchyardManagedRuntimeFiles
  $script:calls = @()
  function Protect-PrivateFile([string]$Path) { $script:calls += "protect-$([IO.Path]::GetFileName($Path))" }
  try {
    if ($Mode -eq "restore") {
      $metadata = Get-Content -LiteralPath (Join-Path $rollbackRoot "rollback.json") -Raw -Encoding UTF8 | ConvertFrom-Json
      $existing = Get-ValidatedSwitchyardSnapshotMembership $rollbackRoot $metadata
      if ($Case -eq "changed-file") { Remove-Item -LiteralPath (Join-Path $rollbackRoot "routes.toml") }
      if ($Case -eq "changed-metadata") {
        $metadata.files = @()
        Write-DeploymentJson (Join-Path $rollbackRoot "rollback.json") $metadata
      }
      Restore-Switchyard $existing
      $result = "restored"
    } elseif ($Mode -eq "verdict") {
      $script:verdictIndex = 0
      $verdicts = Get-Content -LiteralPath (Join-Path $FixtureRoot "verdicts.json") -Raw -Encoding UTF8 | ConvertFrom-Json
      $nativeNode = (Get-Command node.exe).Source
      function node {
        if ($args[0] -eq "--input-type=module") {
          $port = "$($args[-1])"
          $script:calls += "offline-$port"
          $global:LASTEXITCODE = if ($Case -eq "live-$port" -or $Case -eq "unknown-$port" -or $Case -eq "stop-live-$port") { 1 } else { 0 }
        } else { & $nativeNode @args }
      }
      function Invoke-NodeJson([string]$Root, [string[]]$Arguments, [string]$Label) {
        $script:calls += "verify-$($Arguments[2])"
        if ($Case -in @("actual-absent", "actual-unknown")) {
          $raw = (& $nativeNode @Arguments | Out-String)
          if ($LASTEXITCODE -ne 0) { throw "Actual owner verify failed." }
          return $raw | ConvertFrom-Json
        }
        if ($Case -eq "query-failure") { throw "Owner query failed." }
        return $verdicts[$script:verdictIndex++]
      }
      function Invoke-RouterService([string]$Root, [string]$Command) { $script:calls += "stop-$Root" }
      if ($Case.StartsWith("stop-")) {
        Stop-RouterGeneration (Join-Path $FixtureRoot "candidate")
        $result = "stopped"
      } else { $result = Resolve-LiveRouterRoot @((Join-Path $FixtureRoot "candidate"), $rollbackRouterRoot) }
    } else { throw "Unknown recovery fixture mode." }
    Write-DeploymentJson (Join-Path $FixtureRoot "outcome.json") @{ succeeded = $true; result = $result; calls = @($script:calls) }
  } catch {
    Write-DeploymentJson (Join-Path $FixtureRoot "outcome.json") @{ succeeded = $false; error = $_.Exception.Message; calls = @($script:calls) }
  }
  return
}
try {
  $plan = Get-SwitchyardRecoveryArchivePlan (Join-Path $FixtureRoot "runtime") (Join-Path $FixtureRoot "state") ("a" * 40)
  if (-not $Preview) { Move-SwitchyardRecoveryArchive $plan }
  Write-DeploymentJson (Join-Path $FixtureRoot "outcome.json") @{ succeeded = $true; plan = $plan }
} catch {
  Write-DeploymentJson (Join-Path $FixtureRoot "outcome.json") @{ succeeded = $false; error = $_.Exception.Message }
}
