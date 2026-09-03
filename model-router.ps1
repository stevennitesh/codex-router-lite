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
if (-not $Root -or -not (Test-Path -LiteralPath (Join-Path $Root "src\start.mjs") -PathType Leaf)) {
  throw "Codex Router checkout not found next to this script."
}
$Commands = @(
  "install", "doctor", "status", "providers", "provider-key", "caller-key",
  "enable", "disable", "uninstall", "update", "rollback", "start", "stop",
  "restart", "subagents", "refresh-catalog"
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
  "install" { & (Join-Path $Root "install.ps1") -CheckoutInstall -Target codex @CommandArguments }
  "enable" { & (Join-Path $Root "install.ps1") -CheckoutInstall -Target codex @CommandArguments }
  "doctor" { Invoke-RouterNode "src\doctor.mjs" $CommandArguments }
  "status" { Invoke-RouterNode "src\doctor.mjs" $CommandArguments }
  "providers" { Invoke-RouterNode "src\control.mjs" (@("providers") + $CommandArguments) }
  "provider-key" { Invoke-RouterNode "src\provider-key.mjs" $CommandArguments }
  "caller-key" { Invoke-RouterNode "src\caller-key.mjs" $CommandArguments }
  "disable" { Remove-CodexIntegration }
  "uninstall" { Remove-CodexIntegration }
  "update" {
    $UpdateArguments = if ($CommandArguments.Count) { $CommandArguments } else { @("update") }
    Invoke-RouterNode "src\update.mjs" $UpdateArguments
  }
  "rollback" { Invoke-RouterNode "src\update.mjs" (@("rollback") + $CommandArguments) }
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
  "subagents" { Invoke-RouterNode "src\control.mjs" (@("subagents") + $CommandArguments) }
  "refresh-catalog" { Invoke-RouterNode "src\refresh-catalog.mjs" $CommandArguments }
}

exit $LASTEXITCODE
