# Resolve only completed acceptance for the installed generation. The caller's
# existing full-health/process preflight must pass before it executes this plan.
function Get-SwitchyardRecoveryArchivePlan([string]$RuntimeRoot, [string]$StateRoot, [string]$InstalledRouterCommit) {
  $runtimePath = [IO.Path]::GetFullPath($RuntimeRoot)
  $backups = @(Get-ChildItem -LiteralPath $runtimePath -Directory -Force -Filter ".rollback-*")
  if (-not $backups.Count) { return $null }
  if ($backups.Count -ne 1) { throw "Multiple Switchyard recovery directories remain; resolve their ownership before deploying." }
  $backup = $backups[0]
  if ($backup.Name -notmatch '^\.rollback-[a-f0-9]{32}$' -or
      $backup.Attributes -band [IO.FileAttributes]::ReparsePoint -or
      [IO.Path]::GetDirectoryName($backup.FullName) -ne $runtimePath) {
    throw "Switchyard recovery directory is not a managed runtime child."
  }
  $metadata = Get-Content -LiteralPath (Join-Path $backup.FullName "rollback.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  $files = @($metadata.files)
  $allowed = @("switchyard-server.exe", "routes.toml", "SOURCE_COMMIT", "provenance.json")
  if ($metadata.version -ne 1 -or $metadata.previousRouterCommit -notmatch '^[a-f0-9]{40}$' -or
      -not [IO.Path]::IsPathRooted("$($metadata.rollbackRouterRoot)") -or
      @($files | Where-Object { $_ -notin $allowed }).Count -or
      @($files | Select-Object -Unique).Count -ne $files.Count) {
    throw "Switchyard recovery metadata is incomplete or invalid."
  }
  foreach ($name in $files) {
    if (-not (Test-Path -LiteralPath (Join-Path $backup.FullName $name) -PathType Leaf)) {
      throw "Switchyard recovery file is missing: $name"
    }
  }
  $deployments = [IO.Path]::GetFullPath((Join-Path $StateRoot "deployments"))
  $acceptedOwners = @()
  if (Test-Path -LiteralPath $deployments -PathType Container) {
    foreach ($operation in Get-ChildItem -LiteralPath $deployments -Directory) {
      if ($operation.Name -notmatch '^[a-f0-9]{32}$' -or $operation.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
      $resultPath = Join-Path $operation.FullName "result.json"
      if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) { continue }
      try { $result = Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { continue }
      $accepted = $result.acceptance
      if ($result.state -ne "completed" -or $result.succeeded -ne $true -or
          $accepted.version -ne 1 -or $accepted.accepted -ne $true -or $accepted.deployed -ne $true -or
          $accepted.routerCommit -ne $InstalledRouterCommit -or
          "$($accepted.rollbackRoot)" -ne $backup.FullName -or
          "$($accepted.rollbackRouterRoot)" -ne "$($metadata.rollbackRouterRoot)") { continue }
      $requiredChecks = @("switchyardHealth", "taskIdentity", "routerFullHealth", "cleanCandidate", "installManifest",
        "doctor", "protectedEndpoints", "processIdentity", "provenance", "installedHashes", "installedCatalog")
      if (@($requiredChecks | Where-Object { $accepted.checks.$_ -ne $true }).Count -or
          @($accepted.checks.PSObject.Properties | Where-Object { $_.Value -ne $true }).Count) { continue }
      $acceptedOwners += [pscustomobject]@{ resultPath = $resultPath; acceptance = $accepted; operationRoot = $operation.FullName }
    }
  }
  if ($acceptedOwners.Count -ne 1) {
    throw "Existing Switchyard recovery has no unique completed acceptance for the installed generation; retain it and resolve the previous deployment."
  }
  $match = $acceptedOwners[0]
  $provenance = Get-Content -LiteralPath (Join-Path $runtimePath "provenance.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($provenance.routerCommit -ne $InstalledRouterCommit -or
      $provenance.upstreamCommit -ne $match.acceptance.switchyardCommit) {
    throw "Installed Switchyard provenance differs from the accepted recovery owner."
  }
  foreach ($binding in @(@("switchyard-server.exe", "binarySha256", "switchyardBinarySha256"), @("routes.toml", "routesSha256", "switchyardRoutesSha256"))) {
    $expected = "$($match.acceptance.($binding[2]))"
    if ($expected -notmatch '^[a-f0-9]{64}$' -or $provenance.($binding[1]) -ne $expected -or
        (Get-Sha256 (Join-Path $runtimePath $binding[0])) -ne $expected) {
      throw "Installed Switchyard $($binding[0]) differs from the accepted recovery owner."
    }
  }
  $archive = [IO.Path]::GetFullPath((Join-Path $match.operationRoot "retained-runtime-recovery"))
  if ([IO.Path]::GetDirectoryName($match.operationRoot) -ne $deployments -or
      [IO.Path]::GetDirectoryName($archive) -ne $match.operationRoot -or (Test-Path -LiteralPath $archive)) {
    throw "Switchyard recovery archive has an unsafe or already occupied destination."
  }
  [pscustomobject]@{ source = $backup.FullName; destination = $archive; acceptedResult = $match.resultPath }
}

function Move-SwitchyardRecoveryArchive([object]$Plan) {
  if (-not $Plan) { return }
  # A same-volume directory move retains every file and its private ACL. No
  # accepted receipt or detached rollback checkout is rewritten or deleted.
  Move-Item -LiteralPath $Plan.source -Destination $Plan.destination -ErrorAction Stop
  if ((Test-Path -LiteralPath $Plan.source) -or -not (Test-Path -LiteralPath (Join-Path $Plan.destination "rollback.json"))) {
    throw "Switchyard recovery archive read-back failed; inspect $($Plan.destination)."
  }
  Write-Host "Previous accepted recovery copy archived at $($Plan.destination)."
}
function Get-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  try {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
      return ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    } finally {
      $hasher.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

