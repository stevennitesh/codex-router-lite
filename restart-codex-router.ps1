[CmdletBinding()]
param(
  [string]$InstallDir = $(
    if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "codex-router" }
    else { Join-Path $HOME ".local\share\codex-router" }
  ),
  [string]$RepoDir = "E:\GitHub\code\codex-router"
)

$ErrorActionPreference = "Stop"
$routerRoot = [IO.Path]::GetFullPath($InstallDir)
if (-not (Test-Path -LiteralPath (Join-Path $routerRoot "src\service.mjs") -PathType Leaf)) {
  $repoRoot = [IO.Path]::GetFullPath($RepoDir)
  if (Test-Path -LiteralPath (Join-Path $repoRoot "src\service.mjs") -PathType Leaf) {
    Write-Warning "Installed Codex Router not found at $routerRoot; restarting from repository checkout $repoRoot instead."
    $routerRoot = $repoRoot
  } else {
    throw "Codex Router not found at either $routerRoot or $repoRoot."
  }
}
Push-Location $routerRoot
try {
  Write-Host "Gracefully restarting Codex Router..."
  & node (Join-Path $routerRoot "src\service.mjs") restart
  $RestartExitCode = $LASTEXITCODE
  if ($RestartExitCode -ne 0) {
    throw "Codex Router restart failed with exit code $RestartExitCode."
  }
} finally {
  Pop-Location
}

Write-Host "Codex Router is running."
