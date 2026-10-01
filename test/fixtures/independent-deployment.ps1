param([string]$FixtureRoot, [string]$CodeRoot, [switch]$InProcess)
$ErrorActionPreference = "Stop"
if ($InProcess) {
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Path -LiteralPath (Join-Path $FixtureRoot "release.txt"))) {
    if ((Get-Date) -gt $deadline) { throw "Fixture release timed out" }
    Start-Sleep -Milliseconds 50
  }
  # After losing the caller, fail activation and run the shipped rollback path
  # against isolated files (the Windows service boundaries remain fixtures).
  & (Join-Path $CodeRoot "test\fixtures\switchyard-transaction.ps1") -CodeRoot $CodeRoot -FixtureRoot (Join-Path $FixtureRoot "transaction") -Failure install
  Set-Content -LiteralPath (Join-Path $FixtureRoot "survived.txt") -Value "Worker recovered after the caller tree was terminated"
  return
}
$env:CODEX_HOME = $FixtureRoot
. (Join-Path $CodeRoot "maintenance\deployment-runner.ps1")
$launch = Start-IndependentDeployment -ScriptPath $PSCommandPath -Parameters @{ FixtureRoot = $FixtureRoot; CodeRoot = $CodeRoot } -RepoRoot $CodeRoot | Out-String | ConvertFrom-Json
$launch | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $FixtureRoot "launch.json") -Encoding UTF8
Start-Sleep -Seconds 300
