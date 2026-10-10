param([string]$CodeRoot, [string]$FixtureRoot, [switch]$Preview)
$ErrorActionPreference = "Stop"
. (Join-Path $CodeRoot "maintenance/deployment-json.ps1")
. (Join-Path $CodeRoot "maintenance/switchyard-recovery.ps1")
try {
  $plan = Get-SwitchyardRecoveryArchivePlan (Join-Path $FixtureRoot "runtime") (Join-Path $FixtureRoot "state") ("a" * 40)
  if (-not $Preview) { Move-SwitchyardRecoveryArchive $plan }
  Write-DeploymentJson (Join-Path $FixtureRoot "outcome.json") @{ succeeded = $true; plan = $plan }
} catch {
  Write-DeploymentJson (Join-Path $FixtureRoot "outcome.json") @{ succeeded = $false; error = $_.Exception.Message }
}
