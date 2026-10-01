param([Parameter(Mandatory = $true)][string]$RequestPath)
$ErrorActionPreference = "Stop"
$operationRoot = Split-Path -Parent $RequestPath
$resultPath = Join-Path $operationRoot "result.json"
$logPath = Join-Path $operationRoot "deployment.log"
$exitCode = 1
$transcribing = $false
$deploymentLock = $null
$completion = $null
try {
  $request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
  foreach ($property in $request.environment.PSObject.Properties) {
    [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, "Process")
  }
  # Retain the file, but release its exclusive handle on every exit/crash. A
  # stale filename cannot block recovery, and two workers cannot mutate together.
  $lockPath = Join-Path (Split-Path -Parent $operationRoot) "deployment.lock"
  $deploymentLock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  Start-Transcript -LiteralPath $logPath -Append | Out-Null
  $transcribing = $true
  @{ state = "running"; processId = $PID } | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
  $parameters = @{}
  foreach ($property in $request.parameters.PSObject.Properties) { $parameters[$property.Name] = $property.Value }
  & $request.script @parameters
  $exitCode = 0
  $completion = @{ state = "completed"; succeeded = $true }
} catch {
  $failure = $_.Exception.Message
  Write-Host $failure
  $completion = @{ state = "completed"; succeeded = $false; error = $failure }
} finally {
  if ($transcribing) { Stop-Transcript | Out-Null }
  if ($deploymentLock) { $deploymentLock.Dispose() }
}
$completion | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
exit $exitCode
