[CmdletBinding()]
param(
  [Parameter(Position = 0, Mandatory = $true)]
  [ValidateSet("codex")]
  [string]$Target,

  [Parameter(Position = 1, Mandatory = $true)]
  [string]$Command,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CommandArguments
)

$ErrorActionPreference = "Stop"
$env:MODEL_ROUTER_TARGET = "codex"
if ($null -eq $CommandArguments) { $CommandArguments = @() }

$Root = $PSScriptRoot
$Commands = @(
  "setup", "install", "doctor", "status", "providers", "provider-key", "caller-key",
  "key-pool", "enable", "disable", "chatgpt-session", "skills", "uninstall", "update",
  "rollback", "support-bundle", "smoke-test", "start", "stop", "restart", "test-model",
  "subagents", "refresh-catalog"
)
if ($Command -notin $Commands) {
  throw "Unknown command '$Command'. Choose: $($Commands -join ', ')."
}

function Invoke-RouterNode([string]$Script, [string[]]$ScriptArguments = @()) {
  & node (Join-Path $Root $Script) @ScriptArguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Script exited with status $LASTEXITCODE."
  }
}

function Remove-CodexIntegration {
  Invoke-RouterNode "src\config-manager.mjs" @("disable")
  Invoke-RouterNode "src\service.mjs" @("uninstall")
}

switch ($Command) {
  "setup" { Invoke-RouterNode "src\setup.mjs" $CommandArguments }
  "install" { & (Join-Path $Root "install.ps1") -CheckoutInstall -Target codex @CommandArguments }
  "enable" { & (Join-Path $Root "install.ps1") -CheckoutInstall -Target codex @CommandArguments }
  "doctor" { Invoke-RouterNode "src\doctor.mjs" $CommandArguments }
  "status" { Invoke-RouterNode "src\doctor.mjs" $CommandArguments }
  "providers" { Invoke-RouterNode "src\providers.mjs" $CommandArguments }
  "provider-key" { Invoke-RouterNode "src\provider-key.mjs" $CommandArguments }
  "caller-key" { Invoke-RouterNode "src\caller-key.mjs" $CommandArguments }
  "key-pool" { Invoke-RouterNode "src\control.mjs" (@("key-pool") + $CommandArguments) }
  "disable" { Remove-CodexIntegration }
  "chatgpt-session" { Invoke-RouterNode "src\chatgpt-session.mjs" $CommandArguments }
  "skills" { Invoke-RouterNode "src\skills-install.mjs" $CommandArguments }
  "uninstall" { Remove-CodexIntegration }
  "update" {
    $UpdateArguments = if ($CommandArguments.Count) { $CommandArguments } else { @("update") }
    Invoke-RouterNode "src\update.mjs" $UpdateArguments
  }
  "rollback" { Invoke-RouterNode "src\update.mjs" (@("rollback") + $CommandArguments) }
  "support-bundle" { Invoke-RouterNode "src\support-bundle.mjs" $CommandArguments }
  "smoke-test" { Invoke-RouterNode "src\smoke-test.mjs" $CommandArguments }
  "start" {
    if ($CommandArguments.Count -eq 0) {
      Invoke-RouterNode "src\service.mjs" @("start")
    } elseif ($CommandArguments.Count -eq 1 -and $CommandArguments[0] -eq "--foreground") {
      Invoke-RouterNode "src\foreground-start.mjs"
    } else {
      throw "Usage: model-router.ps1 codex start [--foreground]."
    }
  }
  "stop" { Invoke-RouterNode "src\service.mjs" @("stop") }
  "restart" { Invoke-RouterNode "src\service.mjs" @("restart") }
  "test-model" { Invoke-RouterNode "src\compatibility-test.mjs" $CommandArguments }
  "subagents" { Invoke-RouterNode "src\control.mjs" (@("subagents") + $CommandArguments) }
  "refresh-catalog" { Invoke-RouterNode "src\refresh-catalog.mjs" $CommandArguments }
}

exit $LASTEXITCODE
