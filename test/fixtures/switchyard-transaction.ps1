param([string]$CodeRoot, [string]$FixtureRoot, [string]$Failure, [switch]$ForceServiceReplacement)
$ErrorActionPreference = "Stop"
. (Join-Path $CodeRoot "maintenance\deployment-json.ps1")
$repoRoot = Join-Path $FixtureRoot "candidate"
$rollbackRouterRoot = Join-Path $FixtureRoot "previous"
$runtimeRoot = Join-Path $FixtureRoot "runtime"
$stageRoot = Join-Path $FixtureRoot "stage"
$rollbackRoot = Join-Path $FixtureRoot "rollback"
$runningRouterRoot = $rollbackRouterRoot
$script:liveRoot = $runningRouterRoot
$trace = Join-Path $FixtureRoot "trace.txt"
$AcceptancePath = if ($Failure -eq "acceptance") { Join-Path $FixtureRoot "missing\acceptance.json" } else { Join-Path $FixtureRoot "acceptance.json" }
$activationStarted = $false
$keepRollback = $false
$expectedRouterCommit = $routerCommit = "a" * 40
$expectedRollbackCommit = "b" * 40
$expectedBinaryHash = $expectedRoutesHash = $upstreamPatchHash = $templateHash = $templateSourceHash = "c" * 64
$lock = @{ commit = "d" * 40; patchSha256 = "e" * 64 }
$upstreamContribution = @{ pullRequest = 762; sourceCommit = "f" * 40 }
$runtimeFiles = @("switchyard-server.exe", "routes.toml", "SOURCE_COMMIT", "provenance.json")
$existing = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($dir in @($repoRoot, $rollbackRouterRoot, $runtimeRoot, $stageRoot, $rollbackRoot)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
foreach ($name in $runtimeFiles) {
  [IO.File]::WriteAllText((Join-Path $runtimeRoot $name), "previous-$name")
  Copy-Item -LiteralPath (Join-Path $runtimeRoot $name) -Destination (Join-Path $rollbackRoot $name)
  [void]$existing.Add($name)
}
[IO.File]::WriteAllText((Join-Path $stageRoot "switchyard-server.exe"), "candidate-binary")
[IO.File]::WriteAllText((Join-Path $stageRoot "routes.toml"), "candidate-routes")
# Execute the shipped transaction and file-restoration functions. Only the
# Windows/service and authentication boundaries are replaced, never file effects.
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $CodeRoot "maintenance\deploy-switchyard-candidate.ps1"), [ref]$tokens, [ref]$errors)
foreach ($name in @("Copy-RuntimeFile", "Restore-Switchyard")) {
  $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  Invoke-Expression $function.Extent.Text
}
function node { $global:LASTEXITCODE = if ($Failure -eq "configuration") { 1 } else { 0 } }
function Protect-PrivateFile([string]$Path) {}
function Assert-CheckoutIdentity([string]$Root, [string]$Commit, [string]$Label) {}
function Assert-FileHash([string]$Path, [string]$Hash, [string]$Label) { if (-not (Test-Path -LiteralPath $Path)) { throw "Missing $Label" } }
function Invoke-NodeJson([string]$Root, [string[]]$Arguments, [string]$Label) {
  if ($Arguments[1] -eq "resume") { Add-Content -LiteralPath $trace -Value "resume"; return @{ status = "resumed" } }
  Add-Content -LiteralPath $trace -Value "drain"
  if ($Failure -eq "drain") { throw "ERR_ROUTER_DRAIN_DEFERRED" }
  $requestedForce = $Arguments -contains "--force-service-replacement"
  if ($requestedForce -ne [bool]$ForceServiceReplacement) { throw "Force did not match the explicit operator choice" }
  return @{ status = $(if ($requestedForce) { "forced" } else { "drained" }) }
}
function Stop-RouterGeneration([string]$Root) {
  $label = if ($Root -eq $repoRoot) { "candidate" } else { "previous" }
  Add-Content -LiteralPath $trace -Value "stop-$label"
  if ($Root -ne $script:liveRoot) { throw "Attempted to stop the wrong generation" }
  if ($Failure -eq "stop") { throw "Verified process did not stop" }
  if ($Failure -eq "rollback-stop" -and $Root -eq $repoRoot) { throw "Candidate process did not stop" }
  $script:liveRoot = $null
}
function Resolve-LiveRouterRoot([string[]]$AllowedRoots) { return $script:liveRoot }
function Invoke-RouterInstall([string]$Root) {
  $label = if ($Root -eq $repoRoot) { "candidate" } else { "previous" }
  Add-Content -LiteralPath $trace -Value "install-$label"
  $script:liveRoot = $Root
  if ($Root -eq $repoRoot -and $Failure -in @("install", "rollback-stop", "rollback-install")) { throw "Candidate installation failed" }
  if ($Root -eq $rollbackRouterRoot -and $Failure -eq "rollback-install") { throw "Previous installation failed" }
}
function Assert-RouterHealth([string]$Root, [string]$Commit) {
  if ($Root -ne $script:liveRoot) { throw "Wrong generation served health" }
  Add-Content -LiteralPath $trace -Value $(if ($Root -eq $repoRoot) { "healthy-candidate" } else { "healthy-previous" })
  if ($Root -eq $repoRoot -and $Failure -eq "health") { throw "Candidate health failed" }
}
function Assert-SwitchyardHealth {}
function Assert-ProtectedSwitchyardEndpoint([string]$Path) {}
function Assert-CodexCatalog([string]$Root) {}
try { . (Join-Path $CodeRoot "maintenance\switchyard-activation.ps1") }
catch { [IO.File]::WriteAllText((Join-Path $FixtureRoot "error.txt"), $_.Exception.Message) }
@{ activationStarted = $activationStarted; keepRollback = $keepRollback; liveRoot = $script:liveRoot } | ConvertTo-Json |
  Set-Content -LiteralPath (Join-Path $FixtureRoot "outcome.json") -Encoding UTF8
