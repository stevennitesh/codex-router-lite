param([string]$CodeRoot, [string]$FixtureRoot, [string]$Case)
$ErrorActionPreference = "Stop"
$Root = Join-Path $FixtureRoot "previous"
New-Item -ItemType Directory -Path $Root -Force | Out-Null
$savedModel = $env:MODEL_ROUTER_STATE_DIR
$savedCodex = $env:CODEX_ROUTER_STATE_DIR
$env:MODEL_ROUTER_STATE_DIR = Join-Path $FixtureRoot "original-model-state"
$env:CODEX_ROUTER_STATE_DIR = Join-Path $FixtureRoot "original-codex-state"
$originalModel = $env:MODEL_ROUTER_STATE_DIR
$originalCodex = $env:CODEX_ROUTER_STATE_DIR
$installer = Join-Path $Root "install.ps1"
$parameter = if ($Case -eq "new") { '[switch]$DependenciesOnly' } else { '[switch]$PrepareOnly' }
$body = @'
param([switch]$CheckoutInstall, PARAMETER, [string]$Target)
@{ dependenciesOnly = [bool]$DependenciesOnly; prepareOnly = [bool]$PrepareOnly; modelState = $env:MODEL_ROUTER_STATE_DIR; codexState = $env:CODEX_ROUTER_STATE_DIR } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot "call.json") -Encoding UTF8
if ($PrepareOnly) {
  New-Item -ItemType Directory -Path $env:MODEL_ROUTER_STATE_DIR -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $env:MODEL_ROUTER_STATE_DIR "generated.txt"), "isolated old-generation state")
}
FAILURE
$global:LASTEXITCODE = 0
'@
$body = $body.Replace("PARAMETER", $parameter).Replace("FAILURE", $(if ($Case -eq "failure") { 'throw "fixture preparation failure"' } else { '' }))
[IO.File]::WriteAllText($installer, $body)
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $CodeRoot "maintenance\deploy-switchyard-candidate.ps1"), [ref]$tokens, [ref]$errors)
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq "Prepare-RollbackRouter" }, $true)
Invoke-Expression $function.Extent.Text
function node {
  $global:LASTEXITCODE = 0
  if (Test-Path -LiteralPath (Join-Path $Root "call.json")) { "skip" } else { "run" }
}
$failure = $null
try { Prepare-RollbackRouter $Root } catch { $failure = $_.Exception.Message }
@{ error = $failure; modelState = $env:MODEL_ROUTER_STATE_DIR; codexState = $env:CODEX_ROUTER_STATE_DIR; originalModel = $originalModel; originalCodex = $originalCodex; installerUnchanged = ([IO.File]::ReadAllText($installer) -eq $body); remainingPreparationTrees = @(Get-ChildItem -LiteralPath (Join-Path $Root "generated") -Directory -ErrorAction SilentlyContinue).Count } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $FixtureRoot "outcome.json") -Encoding UTF8
if ($null -ne $savedModel) { $env:MODEL_ROUTER_STATE_DIR = $savedModel } else { Remove-Item Env:\MODEL_ROUTER_STATE_DIR -ErrorAction SilentlyContinue }
if ($null -ne $savedCodex) { $env:CODEX_ROUTER_STATE_DIR = $savedCodex } else { Remove-Item Env:\CODEX_ROUTER_STATE_DIR -ErrorAction SilentlyContinue }
