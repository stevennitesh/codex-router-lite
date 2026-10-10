# Windows PowerShell's -Encoding UTF8 adds a BOM; Node JSON.parse rejects it.
# Use the same explicit encoding on Windows PowerShell and PowerShell Core.
# File readers must also specify UTF8; Windows PowerShell otherwise uses ANSI.
function Write-DeploymentJson([string]$Path, [object]$Value) {
  $json = $Value | ConvertTo-Json -Depth 6
  [IO.File]::WriteAllText($Path, $json, (New-Object Text.UTF8Encoding($false)))
}
