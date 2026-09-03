[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$InstallDir = $(
    if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "codex-router" }
    else { Join-Path $HOME ".local\share\codex-router" }
  )
)

$ErrorActionPreference = "Stop"
$sourceDir = (Resolve-Path (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$installDir = [IO.Path]::GetFullPath($InstallDir)
$DeployManifestName = ".codex-router-deploy-manifest.json"
$DeployManifestPath = Join-Path $installDir $DeployManifestName
$ExcludedDirectoryNames = @(
  ".git", ".venv", "node_modules", "target", "dist", "release", "release-local"
)

function Get-NormalizedDirectory([string]$Path) {
  return [IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\', '/'))
}

function Test-NestedDirectory([string]$Candidate, [string]$Container) {
  $CandidatePath = "$(Get-NormalizedDirectory $Candidate)\"
  $ContainerPath = "$(Get-NormalizedDirectory $Container)\"
  return $CandidatePath.StartsWith($ContainerPath, [StringComparison]::OrdinalIgnoreCase)
}

function Get-DeploySourceFiles {
  $SourcePrefix = "$(Get-NormalizedDirectory $sourceDir)\"
  $Pending = New-Object 'System.Collections.Generic.Stack[string]'
  $Pending.Push($sourceDir)
  $Files = New-Object 'System.Collections.Generic.List[string]'
  while ($Pending.Count -gt 0) {
    $Directory = $Pending.Pop()
    foreach ($Entry in Get-ChildItem -LiteralPath $Directory -Force) {
      if ($Entry.PSIsContainer) {
        if (($Entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 -and
            $ExcludedDirectoryNames -notcontains $Entry.Name) {
          $Pending.Push($Entry.FullName)
        }
        continue
      }
      if ($Entry.Name -eq $DeployManifestName) { continue }
      $Files.Add($Entry.FullName.Substring($SourcePrefix.Length))
    }
  }
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
  # Copy without a blanket purge, then retire only files recorded by the prior
  # deployment. That removes renamed config fragments (the registry loads them
  # recursively) while preserving operator notes and unrelated target files.
  $CurrentDeployFiles = @(Get-DeploySourceFiles)
  $RobocopyArguments = @(
    $sourceDir,
    $installDir,
    "/E",
    "/COPY:DAT",
    "/DCOPY:DAT",
    "/R:2",
    "/W:1",
    "/XJ",
    "/XD",
    ".git",
    ".venv",
    "node_modules",
    "target",
    "dist",
    "release",
    "release-local"
  )
  # From PowerShell 7.4, $PSNativeCommandUseErrorActionPreference defaults to
  # true, so under $ErrorActionPreference = "Stop" a robocopy that copied files
  # (exit 1 is normal success) would terminate before we could read its
  # meaning -- the 0-7 convention below is exactly what this script has to
  # honor. Disable it around the call only, then restore, so the rest of the
  # script keeps its strict error semantics. On Windows PowerShell 5.1 the
  # preference does not exist; saving it still yields $null and restoring $null
  # changes nothing, so the call is left harmless there too.
  $SavedNativeUseErrorActionPref = $PSNativeCommandUseErrorActionPreference
  $PSNativeCommandUseErrorActionPreference = $false
  try {
    & robocopy @RobocopyArguments
  } finally {
    $PSNativeCommandUseErrorActionPreference = $SavedNativeUseErrorActionPref
  }
  $CopyExitCode = $LASTEXITCODE
  if ($CopyExitCode -gt 7) { throw "robocopy failed with exit code $CopyExitCode." }
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
