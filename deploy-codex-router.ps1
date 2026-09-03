[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$RepoDir = "E:\GitHub\code\codex-router",
  [string]$InstallDir = $(
    if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "codex-router" }
    else { Join-Path $HOME ".local\share\codex-router" }
  )
)

$ErrorActionPreference = "Stop"
$scriptDir = (Resolve-Path (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$preferredRepoDir = [IO.Path]::GetFullPath($RepoDir)
$sourceDir = if (Test-Path -LiteralPath (Join-Path $scriptDir "src\start.mjs") -PathType Leaf) {
  $scriptDir
} elseif (Test-Path -LiteralPath (Join-Path $preferredRepoDir "src\start.mjs") -PathType Leaf) {
  $preferredRepoDir
} else {
  throw "Router source not found next to this script ($scriptDir) or at configured repository path $preferredRepoDir."
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
  foreach ($RelativePath in $CurrentDeployFiles) {
    $SourceFile = Join-Path $sourceDir $RelativePath
    $TargetFile = Resolve-ManagedTargetFile $RelativePath
    $TargetDirectory = Split-Path -Parent $TargetFile
    if (-not (Test-Path -LiteralPath $TargetDirectory -PathType Container)) {
      New-Item -ItemType Directory -Force -Path $TargetDirectory | Out-Null
    }
    Copy-Item -LiteralPath $SourceFile -Destination $TargetFile -Force
  }
  Update-DeployManifest $CurrentDeployFiles

  Push-Location $installDir
  try {
    # This is the supported update transaction: dependency fingerprints,
    # generated catalogs, Codex configuration, manifest, service health, and
    # managed skills stay in one path. It reads the current provider selection
    # rather than replacing it.
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
  Write-Host "Codex Router published, installed, and verified."
}
