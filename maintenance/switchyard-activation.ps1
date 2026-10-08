$admissionPrepared = $false
try {
  Assert-CheckoutIdentity $repoRoot $expectedRouterCommit "Router candidate checkout"
  # A refused drain has no activation effects and must never enter rollback.
  Write-Host "Draining admitted Router requests with a 90-second limit."
  $drainArguments = @(
    (Join-Path $repoRoot "src\service-drain.mjs"), "prepare",
    "--timeout-ms", "90000", "--json-errors"
  )
  if ($ForceServiceReplacement) {
    Write-Warning "Explicit service replacement will interrupt active work and clear indeterminate workflow state."
    $drainArguments += "--force-service-replacement"
  }
  $drain = Invoke-NodeJson $repoRoot $drainArguments "Router admission drain"
  $admissionPrepared = $drain.status -in @("drained", "forced")
  # Canonicalize the managed block while the known-good service is still up.
  # If this write fails, the transaction aborts before any process stops.
  & node (Join-Path $repoRoot "src\config-manager.mjs") enable | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Codex configuration update failed before restart." }

  Assert-CheckoutIdentity $repoRoot $expectedRouterCommit "Router candidate checkout"
  $activationStarted = $true
  $keepRollback = $true
  Stop-RouterGeneration $runningRouterRoot
  Copy-RuntimeFile $stageRoot $runtimeRoot "switchyard-server.exe"
  Copy-RuntimeFile $stageRoot $runtimeRoot "routes.toml"
  Protect-PrivateFile (Join-Path $runtimeRoot "routes.toml")
  "$($lock.commit) + PR $($upstreamContribution.pullRequest) $($upstreamPatchHash.Substring(0, 12)) + local patch $($lock.patchSha256.Substring(0, 12))" |
    Set-Content -LiteralPath (Join-Path $runtimeRoot "SOURCE_COMMIT") -Encoding ASCII
  $candidateProvenance = @{
    version = 1
    upstreamCommit = $lock.commit
    upstreamContributionCommit = "$($upstreamContribution.sourceCommit)".ToLowerInvariant()
    upstreamContributionSha256 = $upstreamPatchHash
    patchSha256 = $lock.patchSha256.ToLowerInvariant()
    binarySha256 = $expectedBinaryHash
    templateSha256 = $templateHash
    templateSourceSha256 = $templateSourceHash
    routesSha256 = $expectedRoutesHash
    routerCommit = $routerCommit
    deployedAt = (Get-Date).ToUniversalTime().ToString("o")
  }
  Write-DeploymentJson (Join-Path $runtimeRoot "provenance.json") $candidateProvenance

  Invoke-RouterInstall $repoRoot
  Assert-FileHash (Join-Path $runtimeRoot "switchyard-server.exe") $expectedBinaryHash "Installed Switchyard binary"
  Assert-FileHash (Join-Path $runtimeRoot "routes.toml") $expectedRoutesHash "Installed Switchyard routes"
  Assert-RouterHealth $repoRoot $routerCommit
  Assert-SwitchyardHealth
  foreach ($path in @("/v1/models", "/v1/decision")) { Assert-ProtectedSwitchyardEndpoint $path }
  Assert-CodexCatalog $repoRoot
  Assert-CheckoutIdentity $repoRoot $expectedRouterCommit "Running Router candidate checkout"
  $provenance = Get-Content -Raw -LiteralPath (Join-Path $runtimeRoot "provenance.json") | ConvertFrom-Json
  if (
    $provenance.upstreamCommit -ne $lock.commit -or
    $provenance.upstreamContributionCommit -ne "$($upstreamContribution.sourceCommit)".ToLowerInvariant() -or
    $provenance.upstreamContributionSha256 -ne $upstreamPatchHash -or
    $provenance.patchSha256 -ne $lock.patchSha256.ToLowerInvariant() -or
    $provenance.binarySha256 -ne $expectedBinaryHash -or
    $provenance.templateSha256 -ne $templateHash -or
    $provenance.templateSourceSha256 -ne $templateSourceHash -or
    $provenance.routesSha256 -ne $expectedRoutesHash -or
    $provenance.routerCommit -ne $routerCommit
  ) {
    throw "Installed Switchyard provenance does not match the candidate."
  }
  $keepRollback = $true
  $accepted = [pscustomobject]@{
    version = 1
    accepted = $true
    acceptedAt = (Get-Date).ToUniversalTime().ToString("o")
    deployed = $true
    routerCommit = $routerCommit
    switchyardCommit = $lock.commit
    switchyardBinarySha256 = $expectedBinaryHash
    switchyardRoutesSha256 = $expectedRoutesHash
    rollbackRoot = $rollbackRoot
    rollbackRouterRoot = $rollbackRouterRoot
    checks = @{
      routerFullHealth = $true
      doctor = $true
      taskIdentity = $true
      processIdentity = $true
      installManifest = $true
      switchyardHealth = $true
      protectedEndpoints = $true
      installedCatalog = $true
      installedHashes = $true
      provenance = $true
      cleanCandidate = $true
    }
  }
  if ($AcceptancePath) { Write-DeploymentJson $AcceptancePath $accepted }
  $accepted | ConvertTo-Json -Depth 3
} catch {
  $deploymentError = $_
  if (-not $activationStarted) {
    if ($admissionPrepared) {
      Invoke-NodeJson $repoRoot @((Join-Path $repoRoot "src\service-drain.mjs"), "resume") "Router admission restore" | Out-Null
    }
    throw "Candidate deployment aborted before the running service changed: $($deploymentError.Exception.Message)"
  }
  try {
    # Stop only the verified live generation. A failed stop forbids file replacement.
    $failedRoot = Resolve-LiveRouterRoot @($repoRoot, $rollbackRouterRoot)
    if ($failedRoot) { Stop-RouterGeneration $failedRoot }
    Restore-Switchyard $existing
    Assert-CheckoutIdentity $rollbackRouterRoot $expectedRollbackCommit "Rollback Router checkout"
    Invoke-RouterInstall $rollbackRouterRoot
    Assert-RouterHealth $rollbackRouterRoot $expectedRollbackCommit
    Assert-SwitchyardHealth
    Assert-CheckoutIdentity $rollbackRouterRoot $expectedRollbackCommit "Running rollback Router checkout"
    $keepRollback = $true
  } catch {
    $keepRollback = $true
    throw "Candidate deployment failed ($($deploymentError.Exception.Message)) and rollback failed ($($_.Exception.Message)). Recovery files remain at $rollbackRoot."
  }
  throw "Candidate deployment failed; the exact previous Router and Switchyard generation was restored: $($deploymentError.Exception.Message)"
}
