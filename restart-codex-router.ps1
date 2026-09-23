[CmdletBinding()]
param(
  [switch]$ForceServiceReplacement,
  [string]$InstallDir = $(Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) "codex-router")
)

$ErrorActionPreference = "Stop"
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
