[CmdletBinding()]
param(
  [switch]$ForceServiceReplacement,
  [string]$InstallDir
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($InstallDir)) {
  $InstallDir = (& node (Join-Path $PSScriptRoot "src\install-manifest.mjs") root | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $InstallDir) {
    throw "The recorded Codex Router installation could not be resolved. Pass -InstallDir explicitly."
  }
}
$routerRoot = [IO.Path]::GetFullPath($InstallDir)
if (-not (Test-Path -LiteralPath (Join-Path $routerRoot "src\service.mjs") -PathType Leaf)) {
  throw "Installed Codex Router not found at $routerRoot. Pass -InstallDir to restart a different installation."
}
Push-Location $routerRoot
try {
  Write-Host "Gracefully restarting Codex Router..."
  $ServiceArguments = @("restart")
  if ($ForceServiceReplacement) { $ServiceArguments += "--force-service-replacement" }
  & node (Join-Path $routerRoot "src\service.mjs") @ServiceArguments
  $RestartExitCode = $LASTEXITCODE
  if ($RestartExitCode -ne 0) {
    throw "Codex Router restart failed with exit code $RestartExitCode."
  }
} finally {
  Pop-Location
}

Write-Host "Codex Router is running."
