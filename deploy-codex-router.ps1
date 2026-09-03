[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$InstallDir = $(
    if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "codex-router" }
    else { Join-Path $HOME ".local\share\codex-router" }
  )
)

$ErrorActionPreference = "Stop"
$scriptDir = (Resolve-Path (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$sourceDir = $scriptDir
if (-not (Test-Path -LiteralPath (Join-Path $sourceDir "src\start.mjs") -PathType Leaf)) {
  throw "Router source not found next to this script: $sourceDir."
}
$installDir = [IO.Path]::GetFullPath($InstallDir)
$DeployManifestName = ".codex-router-deploy-manifest.json"
$DeployManifestPath = Join-Path $installDir $DeployManifestName
$SourceManifestPath = Join-Path $sourceDir "maintenance\windows-package.json"

function Get-NormalizedDirectory([string]$Path) {
  return [IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\', '/'))
}

function Test-NestedDirectory([string]$Candidate, [string]$Container) {
  $CandidatePath = "$(Get-NormalizedDirectory $Candidate)\"
  $ContainerPath = "$(Get-NormalizedDirectory $Container)\"
  return $CandidatePath.StartsWith($ContainerPath, [StringComparison]::OrdinalIgnoreCase)
}

function Get-DeploySourceFiles {
  if (-not (Test-Path -LiteralPath $SourceManifestPath -PathType Leaf)) {
    throw "Windows package manifest not found at $SourceManifestPath."
  }
  $Document = Get-Content -LiteralPath $SourceManifestPath -Raw | ConvertFrom-Json
  if ($Document.version -ne 1 -or $null -eq $Document.files) {
    throw "Unsupported Windows package manifest."
  }
  $Files = @($Document.files | ForEach-Object {
    if ($_ -isnot [string] -or -not $_ -or [IO.Path]::IsPathRooted($_) -or
        @($_ -split '[\\/]') -contains '..') {
      throw "The Windows package manifest contains an unsafe path."
    }
    $SourceFile = Join-Path $sourceDir $_
    if (-not (Test-Path -LiteralPath $SourceFile -PathType Leaf)) {
      throw "The Windows package manifest names a missing file: $_"
    }
    $_
  })
  return @($Files | Sort-Object -Unique)
}

function Read-DeployManifest {
  if (-not (Test-Path -LiteralPath $DeployManifestPath -PathType Leaf)) { return @() }
  try {
    $Document = Get-Content -LiteralPath $DeployManifestPath -Raw | ConvertFrom-Json
    if ($Document.version -ne 1 -or $null -eq $Document.files) {
      throw "unsupported manifest shape"
    }
    return @($Document.files | ForEach-Object {
      if ($_ -isnot [string] -or -not $_) { throw "invalid managed path" }
      $_
    })
  } catch {
    throw "Refusing deployment because $DeployManifestPath is invalid: $($_.Exception.Message)"
  }
}

function Resolve-ManagedTargetFile([string]$RelativePath) {
  if ([IO.Path]::IsPathRooted($RelativePath)) {
    throw "The deployment manifest contains an absolute path."
  }
  $Segments = @($RelativePath -split '[\\/]')
  if ($Segments.Count -eq 0 -or $Segments -contains "" -or
      $Segments -contains "." -or $Segments -contains "..") {
    throw "The deployment manifest contains an unsafe relative path."
  }
  $InstallPrefix = "$(Get-NormalizedDirectory $installDir)\"
  $Target = [IO.Path]::GetFullPath((Join-Path $installDir $RelativePath))
  if (-not $Target.StartsWith($InstallPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "The deployment manifest path escapes the installed checkout."
  }
  $Cursor = Get-NormalizedDirectory $installDir
  foreach ($Segment in $Segments[0..([Math]::Max(0, $Segments.Count - 2))]) {
    if ($Segments.Count -eq 1) { break }
    $Cursor = Join-Path $Cursor $Segment
    if (Test-Path -LiteralPath $Cursor) {
      $Attributes = (Get-Item -LiteralPath $Cursor -Force).Attributes
      if (($Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to prune through reparse point $Cursor."
      }
    }
  }
  return $Target
}

function Update-DeployManifest([string[]]$CurrentFiles) {
  $Current = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($RelativePath in $CurrentFiles) { [void]$Current.Add($RelativePath) }
  foreach ($RelativePath in Read-DeployManifest) {
    if ($Current.Contains($RelativePath)) { continue }
    $Target = Resolve-ManagedTargetFile $RelativePath
    if (Test-Path -LiteralPath $Target -PathType Leaf) {
      Remove-Item -LiteralPath $Target -Force
    }
  }

  $Temporary = "$DeployManifestPath.tmp.$PID"
  try {
    @{ version = 1; files = @($CurrentFiles) } |
      ConvertTo-Json -Depth 3 |
      Set-Content -LiteralPath $Temporary -Encoding UTF8
    Move-Item -LiteralPath $Temporary -Destination $DeployManifestPath -Force
  } finally {
    if (Test-Path -LiteralPath $Temporary) { Remove-Item -LiteralPath $Temporary -Force }
  }
}

function Copy-ManagedFiles([string]$FromRoot, [string]$ToRoot, [string[]]$Files) {
  foreach ($RelativePath in $Files) {
    $SourceFile = Join-Path $FromRoot $RelativePath
    $TargetFile = Join-Path $ToRoot $RelativePath
    $TargetDirectory = Split-Path -Parent $TargetFile
    if (-not (Test-Path -LiteralPath $TargetDirectory -PathType Container)) {
      New-Item -ItemType Directory -Force -Path $TargetDirectory | Out-Null
    }
    Copy-Item -LiteralPath $SourceFile -Destination $TargetFile -Force
  }
}

function Get-Sha256([string]$Path) {
  $Stream = [IO.File]::OpenRead($Path)
  try {
    $Hasher = [Security.Cryptography.SHA256]::Create()
    try {
      return ([BitConverter]::ToString($Hasher.ComputeHash($Stream))).Replace("-", "")
    } finally {
      $Hasher.Dispose()
    }
  } finally {
    $Stream.Dispose()
  }
}

function Assert-StagedFiles([string]$StageRoot, [string[]]$Files) {
  foreach ($RelativePath in $Files) {
    $SourceHash = Get-Sha256 (Join-Path $sourceDir $RelativePath)
    $StageHash = Get-Sha256 (Join-Path $StageRoot $RelativePath)
    if ($SourceHash -ne $StageHash) {
      throw "Staged candidate verification failed for $RelativePath."
    }
  }
}

function Restore-ManagedFiles(
  [string]$BackupRoot,
  [string[]]$ManagedFiles,
  [Collections.Generic.HashSet[string]]$PreviouslyExisting
) {
  foreach ($RelativePath in $ManagedFiles) {
    $TargetFile = Resolve-ManagedTargetFile $RelativePath
    if ($PreviouslyExisting.Contains($RelativePath)) {
      $TargetDirectory = Split-Path -Parent $TargetFile
      if (-not (Test-Path -LiteralPath $TargetDirectory -PathType Container)) {
        New-Item -ItemType Directory -Force -Path $TargetDirectory | Out-Null
      }
      Copy-Item -LiteralPath (Join-Path $BackupRoot $RelativePath) -Destination $TargetFile -Force
    } elseif (Test-Path -LiteralPath $TargetFile -PathType Leaf) {
      Remove-Item -LiteralPath $TargetFile -Force
    }
  }
}

if ((Test-NestedDirectory $sourceDir $installDir) -or
    (Test-NestedDirectory $installDir $sourceDir)) {
  throw "Source and install directories must be separate and neither may contain the other."
}
if (-not (Test-Path (Join-Path $sourceDir "src\start.mjs"))) {
  throw "Router source not found at $sourceDir."
}
if (-not (Test-Path (Join-Path $installDir "src\start.mjs"))) {
  throw "Installed router not found at $installDir."
}

Write-Host "Publishing $sourceDir"
Write-Host "        to $installDir"

if ($PSCmdlet.ShouldProcess($installDir, "copy router source")) {
  $CurrentDeployFiles = @(Get-DeploySourceFiles)
  $PreviousDeployFiles = @(Read-DeployManifest)
  $ManagedFiles = @($CurrentDeployFiles + $PreviousDeployFiles | Sort-Object -Unique)
  $PreviouslyExisting = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $TemporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "codex-router-deploy-$([Guid]::NewGuid().ToString('N'))"
  $StageRoot = Join-Path $TemporaryRoot "stage"
  $BackupRoot = Join-Path $TemporaryRoot "backup"
  $ManifestExisted = Test-Path -LiteralPath $DeployManifestPath -PathType Leaf
  $KeepBackup = $false
  try {
    New-Item -ItemType Directory -Force -Path $StageRoot, $BackupRoot | Out-Null
    Copy-ManagedFiles $sourceDir $StageRoot $CurrentDeployFiles
    Assert-StagedFiles $StageRoot $CurrentDeployFiles

    foreach ($RelativePath in $ManagedFiles) {
      $TargetFile = Resolve-ManagedTargetFile $RelativePath
      if (Test-Path -LiteralPath $TargetFile -PathType Leaf) {
        [void]$PreviouslyExisting.Add($RelativePath)
        Copy-ManagedFiles $installDir $BackupRoot @($RelativePath)
      }
    }
    if ($ManifestExisted) {
      Copy-Item -LiteralPath $DeployManifestPath -Destination (Join-Path $BackupRoot $DeployManifestName) -Force
    }

    try {
      Copy-ManagedFiles $StageRoot $installDir $CurrentDeployFiles
      Update-DeployManifest $CurrentDeployFiles

      Push-Location $installDir
      try {
        # This is the supported update transaction: dependency fingerprints,
        # generated catalogs, Codex configuration, manifest, service health,
        # and managed skills stay in one path. It reads the current provider
        # selection rather than replacing it.
        & (Join-Path $installDir "install.ps1") -CheckoutInstall -Target codex
        if (-not $?) { throw "The installed Codex Router update failed." }

        & node (Join-Path $installDir "src\doctor.mjs")
        $DoctorExitCode = $LASTEXITCODE
        if ($DoctorExitCode -ne 0) {
          throw "Codex Router doctor failed with exit code $DoctorExitCode."
        }
      } finally {
        Pop-Location
      }
    } catch {
      $DeployError = $_
      try {
        Restore-ManagedFiles $BackupRoot $ManagedFiles $PreviouslyExisting
        if ($ManifestExisted) {
          Copy-Item -LiteralPath (Join-Path $BackupRoot $DeployManifestName) -Destination $DeployManifestPath -Force
        } elseif (Test-Path -LiteralPath $DeployManifestPath -PathType Leaf) {
          Remove-Item -LiteralPath $DeployManifestPath -Force
        }
        Push-Location $installDir
        try {
          & (Join-Path $installDir "install.ps1") -CheckoutInstall -Target codex
          if (-not $?) { throw "The previous Codex Router generation could not be restarted." }
          & node (Join-Path $installDir "src\doctor.mjs")
          if ($LASTEXITCODE -ne 0) { throw "The restored Codex Router generation failed doctor." }
        } finally {
          Pop-Location
        }
      } catch {
        $KeepBackup = $true
        throw "Deployment failed ($($DeployError.Exception.Message)) and rollback failed ($($_.Exception.Message)). The backup remains at $BackupRoot."
      }
      throw "Deployment failed; the previous healthy generation was restored: $($DeployError.Exception.Message)"
    }
    Write-Host "Codex Router published, installed, and verified."
  } finally {
    if (-not $KeepBackup -and (Test-Path -LiteralPath $TemporaryRoot)) {
      Remove-Item -LiteralPath $TemporaryRoot -Recurse -Force
    }
  }
}
