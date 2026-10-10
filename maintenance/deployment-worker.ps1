param([Parameter(Mandatory = $true)][string]$RequestPath)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "deployment-json.ps1")
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
  Write-DeploymentJson $resultPath @{ state = "running"; processId = $PID }
  $parameters = @{}
  foreach ($property in $request.parameters.PSObject.Properties) { $parameters[$property.Name] = $property.Value }
  $acceptancePath = Join-Path $operationRoot "acceptance.json"
  if ($request.requireAcceptance) { $parameters["AcceptancePath"] = $acceptancePath }
  # PowerShell does not throw for a script's nonzero exit or a failed native
  # command. Check that outcome before accepting even a valid-looking receipt.
  $global:LASTEXITCODE = 0
  & $request.script @parameters
  if ($LASTEXITCODE -ne 0) { throw "Deployment script exited with status $LASTEXITCODE." }
  $acceptance = $null
  if ($request.requireAcceptance) {
    $acceptance = Get-Content -Raw -LiteralPath $acceptancePath | ConvertFrom-Json
    if ($acceptance.version -ne 1 -or $acceptance.accepted -ne $true -or
        $acceptance.routerCommit -ne $parameters["ExpectedRouterCommit"].ToLowerInvariant() -or
        $acceptance.switchyardBinarySha256 -ne $parameters["ExpectedBinarySha256"].ToLowerInvariant() -or
        -not $acceptance.checks -or -not @($acceptance.checks.PSObject.Properties).Count -or
        @($acceptance.checks.PSObject.Properties | Where-Object { $_.Value -ne $true }).Count) {
      throw "Deployment did not publish a complete acceptance result for the requested candidate."
    }
  }
  $exitCode = 0
  $completion = @{ state = "completed"; succeeded = $true }
  if ($acceptance) { $completion["acceptance"] = $acceptance }
} catch {
  $failure = $_.Exception.Message
  Write-Host $failure
  $completion = @{ state = "completed"; succeeded = $false; error = $failure }
} finally {
  if ($transcribing) { Stop-Transcript | Out-Null }
  if ($deploymentLock) { $deploymentLock.Dispose() }
}
Write-DeploymentJson $resultPath $completion
exit $exitCode
