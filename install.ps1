[CmdletBinding()]
param(
  [switch]$CheckoutInstall,
  [switch]$PrepareOnly,
  [switch]$DependenciesOnly,
  [switch]$ForceDeps,
  [switch]$ForceServiceReplacement,
  [ValidateSet("codex")]
  [string]$Target = "codex",
  [string]$Providers,
  [switch]$NoProvider,
  # Discards tracked edits in the managed checkout so the update can proceed.
  # Deliberately never touches untracked files -- see Reset-ManagedCheckout.
  [switch]$Force,
  [string]$InstallDir = $(Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) "codex-router")
)

$ErrorActionPreference = "Stop"
$env:MODEL_ROUTER_TARGET = $Target
# Keep a one-element array: splatting a scalar string passes its characters.
[string[]]$ServiceMutationArguments = @()
if ($ForceServiceReplacement) { $ServiceMutationArguments += "--force-service-replacement" }
if ($NoProvider -and $Providers) {
  throw "-NoProvider cannot be combined with -Providers."
}
if ($DependenciesOnly -and ($PrepareOnly -or $Providers -or $NoProvider)) {
  throw "-DependenciesOnly cannot be combined with -PrepareOnly or provider selection."
}
$RepositoryUrl = if ($env:CODEX_ROUTER_REPOSITORY_URL) {
  $env:CODEX_ROUTER_REPOSITORY_URL
} else {
  "https://github.com/stevennitesh/codex-router-lite.git"
}

function Assert-Command([string]$Name, [string]$Help) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required. $Help"
  }
}

function Assert-WindowsProcessContainmentCapability {
  if ([string]$ExecutionContext.SessionState.LanguageMode -ne "FullLanguage") {
    throw "Windows process containment requires PowerShell FullLanguage mode; this host's application-control policy exposes $($ExecutionContext.SessionState.LanguageMode)."
  }
  $ProbeName = "CodexRouterInstallProbe$([Guid]::NewGuid().ToString('N'))"
  try {
    Add-Type -TypeDefinition "public static class $ProbeName { public static int Ready = 1; }" -Language CSharp
  } catch {
    throw "Windows process containment requires application-control policy to permit PowerShell Add-Type: $($_.Exception.Message)"
  }
}

function Test-RouterCheckout([string]$Directory) {
  $Package = Join-Path $Directory "package.json"
  if (-not (Test-Path $Package)) { return $false }
  try {
    return (Get-Content $Package -Raw -Encoding UTF8 | ConvertFrom-Json).name -eq "codex-router-lite"
  } catch {
    return $false
  }
}

# Mirrors DIRTY_PREVIEW_LIMIT in src/update.mjs. test/installer-scripts.test.mjs
# imports that constant and compares it with this one, so the two cannot drift.
$DirtyPreviewLimit = 10

# Mirrors localModifications() in src/update.mjs. Only tracked edits are at
# stake: a fast-forward pull never replaces an untracked file, and git refuses
# the rare collision on its own with a precise message. Counting untracked files
# as "local changes" only ever stranded people -- one stray file in the checkout
# and every later self-update was refused.
function Get-LocalModification([string]$Directory) {
  $Output = @(& git -C $Directory status --porcelain --untracked-files=no)
  if ($LASTEXITCODE -ne 0) { throw "Unable to read the Git status of $Directory." }
  return @($Output | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
}

# Mirrors localModificationsMessage() in src/update.mjs. Naming the files and
# both ways forward is the whole point: the old message named neither, so anyone
# blocked by a single stray edit had nothing to act on.
function Get-LocalModificationMessage([string[]]$Changes, [string]$Directory) {
  $Plural = if ($Changes.Count -eq 1) { "" } else { "s" }
  $Lines = @(
    "The checkout has local changes to $($Changes.Count) tracked file${Plural}; refusing to replace them during update:"
  )
  $Lines += @($Changes | Select-Object -First $DirtyPreviewLimit | ForEach-Object { "  $_" })
  $Remainder = $Changes.Count - $DirtyPreviewLimit
  if ($Remainder -gt 0) { $Lines += "  ...and $Remainder more" }
  $Lines += ""
  $Lines += "Keep them:    git -C $Directory stash"
  $Lines += "Discard them: re-run the same command with -Force"
  return ($Lines -join "`n")
}

# Mirrors requireReplaceableCheckout() in src/update.mjs, including its refusal
# to reach for `git clean`: -Force restores files git already tracks and leaves
# untracked files exactly where they are, because an update has no business
# deleting work git was never asked to track.
function Reset-ManagedCheckout([string]$Directory) {
  & git -C $Directory reset --hard HEAD
  if ($LASTEXITCODE -ne 0) { throw "Unable to discard the local changes in $Directory." }
}

function Get-ManagedCheckoutGitValue([string]$Directory, [string[]]$Arguments) {
  $Output = @(& git -C $Directory @Arguments)
  if ($LASTEXITCODE -ne 0) { throw "Unable to read Git $($Arguments -join ' ') in $Directory." }
  return ($Output -join "`n").Trim()
}

function Set-RequestedProviders([string]$Directory, [string]$Selection, [switch]$WithoutProvider) {
  if ($Selection) {
    $NamedProviders = @($Selection.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $Unsupported = @($NamedProviders | Where-Object { $_ -notin @("openrouter", "switchyard") })
    if ($Unsupported.Count -gt 0) { throw "Unsupported provider(s): $($Unsupported -join ', ')." }
    & node (Join-Path $Directory "src\provider-selection.mjs") set @NamedProviders | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Provider selection failed with status $LASTEXITCODE." }
  } elseif ($WithoutProvider) {
    & node (Join-Path $Directory "src\provider-selection.mjs") set | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Provider selection failed with status $LASTEXITCODE." }
  }
}

function Invoke-ManagedCheckoutInstaller(
  [string]$Directory, [switch]$PrepareCatalog, [switch]$PrepareDependencies,
  [switch]$DependencyForce, [switch]$ServiceForce
) {
  # A script can return without running a native command. Do not inherit the
  # status of a previous Git or cleanup command in that case.
  $global:LASTEXITCODE = 0
  $InstallerArguments = @{ CheckoutInstall = $true; Target = "codex"; ForceDeps = [bool]$DependencyForce; ForceServiceReplacement = [bool]$ServiceForce }
  if ($PrepareCatalog) { $InstallerArguments.PrepareOnly = $true }
  if ($PrepareDependencies) { $InstallerArguments.DependenciesOnly = $true }
  & (Join-Path $Directory "install.ps1") @InstallerArguments
  $InstallerExitCode = $LASTEXITCODE
  if ($InstallerExitCode -ne 0) { throw "Installer exited with status $InstallerExitCode." }
}

function Invoke-PreparedManagedCheckoutUpdate(
  [string]$Directory, [switch]$TrackedEditForce, [switch]$ServiceForce,
  [switch]$DependencyForce, [string]$ProviderSelection, [switch]$WithoutProvider
) {
  $Origin = Get-ManagedCheckoutGitValue $Directory @("remote", "get-url", "origin")
  $AllowedOrigins = @(
    $RepositoryUrl,
    "https://github.com/stevennitesh/codex-router-lite",
    "https://github.com/stevennitesh/codex-router-lite.git",
    "git@github.com:stevennitesh/codex-router-lite.git"
  ) | Where-Object { $_ }
  if ($Origin -notin $AllowedOrigins) {
    throw "$Directory has an unrecognized origin and will not be updated: $Origin"
  }
  $Dirty = @(Get-LocalModification $Directory)
  if ($Dirty.Count -and -not $TrackedEditForce) { throw (Get-LocalModificationMessage $Dirty $Directory) }
  $Branch = Get-ManagedCheckoutGitValue $Directory @("branch", "--show-current")
  if ($Branch -and $Branch -ne "main") { throw "$Directory must be on its main branch to update." }
  $PreviousRevision = Get-ManagedCheckoutGitValue $Directory @("rev-parse", "HEAD")
  $Drain = Join-Path $Directory "src\service-drain.mjs"
  $Installer = Join-Path $Directory "install.ps1"
  if (-not (Test-Path -LiteralPath $Drain -PathType Leaf) -or -not (Test-Path -LiteralPath $Installer -PathType Leaf)) {
    throw "The managed checkout lacks the supported replacement preparation and installer entrypoints; it was left unchanged."
  }
  $ParseErrors = $null
  $Tokens = $null
  $InstallerAst = [System.Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$Tokens, [ref]$ParseErrors)
  $InstallerParameters = @($InstallerAst.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
  if ($ParseErrors.Count -or @("CheckoutInstall", "ForceDeps", "ForceServiceReplacement", "Target" | Where-Object { $_ -notin $InstallerParameters }).Count) {
    throw "The managed checkout does not support the guarded installer contract; it was left unchanged."
  }
  & git -C $Directory fetch --quiet origin main
  if ($LASTEXITCODE -ne 0) { throw "Unable to fetch the managed checkout update." }
  $CandidateRevision = Get-ManagedCheckoutGitValue $Directory @("rev-parse", "--verify", "origin/main^{commit}")
  [string[]]$DrainArguments = @($Drain, "prepare")
  if ($ServiceForce) { $DrainArguments += "--force-service-replacement" }
  $PreparationOutput = @(& node @DrainArguments)
  $PreparationExitCode = $LASTEXITCODE
  if ($PreparationExitCode -ne 0) { throw "Router replacement was deferred before the managed checkout changed." }
  try {
    # Even an unsupported success response may have closed admission. Refuse
    # checkout effects, but always attempt resume after a zero-status prepare.
    try { $Preparation = ($PreparationOutput -join "`n") | ConvertFrom-Json }
    catch { throw "Router replacement preparation did not return a supported result; the checkout was left unchanged." }
    if ($Preparation.status -notin @("offline", "drained", "forced", "legacy-force")) {
      throw "Router replacement preparation did not return a supported result; the checkout was left unchanged."
    }
    if ((Get-ManagedCheckoutGitValue $Directory @("rev-parse", "HEAD")) -ne $PreviousRevision -or
        (Get-ManagedCheckoutGitValue $Directory @("branch", "--show-current")) -ne $Branch -or
        (Get-ManagedCheckoutGitValue $Directory @("remote", "get-url", "origin")) -ne $Origin) {
      throw "The checkout changed while preparing replacement; retry the update."
    }
    $Dirty = @(Get-LocalModification $Directory)
    if ($Dirty.Count) {
      if (-not $TrackedEditForce) { throw (Get-LocalModificationMessage $Dirty $Directory) }
      Reset-ManagedCheckout $Directory
    }
    & git -C $Directory update-ref refs/codex-router/rollback $PreviousRevision
    if ($LASTEXITCODE -ne 0) { throw "Unable to record the managed checkout rollback revision." }
    try {
      if (-not $Branch) {
        & git -C $Directory switch main
        if ($LASTEXITCODE -ne 0) { throw "The detached managed checkout could not be restored to main." }
      }
      & git -C $Directory merge --ff-only $CandidateRevision
      if ($LASTEXITCODE -ne 0) { throw "Unable to fast-forward the managed checkout." }
      Set-RequestedProviders $Directory $ProviderSelection -WithoutProvider:$WithoutProvider
      Invoke-ManagedCheckoutInstaller $Directory -DependencyForce:$DependencyForce -ServiceForce:$ServiceForce
    } catch {
      $UpdateFailure = $_
      try {
        & git -C $Directory switch --detach $PreviousRevision
        if ($LASTEXITCODE -ne 0) { throw "Unable to restore the previous managed checkout revision." }
        Invoke-ManagedCheckoutInstaller $Directory -DependencyForce:$DependencyForce -ServiceForce:$ServiceForce
      } catch {
        throw "Update failed ($($UpdateFailure.Exception.Message)) and automatic rollback also failed ($($_.Exception.Message)). The previous commit is $PreviousRevision."
      }
      throw "Update failed ($($UpdateFailure.Exception.Message)); Codex Router was restored to $PreviousRevision."
    }
  } finally {
    # Resume is best effort even after an installer failure. Its native status
    # or PowerShell error must not replace the captured update/install outcome.
    try { & node (Join-Path $Directory "src\service-drain.mjs") resume 2>$null | Out-Null } catch { }
  }
}

# The installed service uses a Windows Job Object so every child is contained.
# Prove the PowerShell capabilities needed to create it before cloning, pulling,
# installing dependencies, changing configuration, or touching service state.
if (-not $DependenciesOnly) { Assert-WindowsProcessContainmentCapability }

$ScriptDirectory = $PSScriptRoot
if (-not $ScriptDirectory) { $ScriptDirectory = (Get-Location).Path }

if (-not $CheckoutInstall) {
  Assert-Command "git" "Install Git for Windows from https://git-scm.com/download/win."
  Assert-Command "node" "Install Node.js 24 LTS from https://nodejs.org/."

  if (Test-RouterCheckout $ScriptDirectory) {
    $Repository = $ScriptDirectory
  } else {
    if (Test-Path (Join-Path $InstallDir ".git")) {
      if (-not (Test-RouterCheckout $InstallDir)) {
        throw "$InstallDir is not a Codex Router checkout."
      }
      # Preparation operates on this exact generation. Advancing it requires
      # the full replacement scope, including drain and checkout revalidation.
      if (-not $PrepareOnly -and -not $DependenciesOnly) {
        Invoke-PreparedManagedCheckoutUpdate $InstallDir -TrackedEditForce:$Force -ServiceForce:$ForceServiceReplacement -DependencyForce:$ForceDeps -ProviderSelection $Providers -WithoutProvider:$NoProvider
        exit 0
      }
    } elseif (Test-Path $InstallDir) {
      throw "$InstallDir exists and is not a Codex Router checkout."
    } else {
      New-Item -ItemType Directory -Force -Path (Split-Path $InstallDir) | Out-Null
      & git clone --depth 1 $RepositoryUrl $InstallDir
      if ($LASTEXITCODE -ne 0) { throw "Unable to clone Codex Router." }
    }
    $Repository = $InstallDir
  }

  if ($PrepareOnly -or $DependenciesOnly) {
    Invoke-ManagedCheckoutInstaller $Repository -PrepareCatalog:$PrepareOnly -PrepareDependencies:$DependenciesOnly -DependencyForce:$ForceDeps -ServiceForce:$ForceServiceReplacement
    exit 0
  }

  Set-RequestedProviders $Repository $Providers -WithoutProvider:$NoProvider
  Invoke-ManagedCheckoutInstaller $Repository -DependencyForce:$ForceDeps -ServiceForce:$ForceServiceReplacement
  exit 0
}

if (-not (Test-RouterCheckout $ScriptDirectory)) {
  throw "-CheckoutInstall must be run from a Codex Router checkout."
}

Assert-Command "node" "Install Node.js 24 LTS from https://nodejs.org/."
Assert-Command "npm" "npm is included with Node.js."
$VersionParts = (node -p "process.versions.node").Split(".")
if ([int]$VersionParts[0] -lt 22 -or
    ([int]$VersionParts[0] -eq 22 -and [int]$VersionParts[1] -lt 19)) {
  throw "Node.js 22.19 or newer is required; Node.js 24 LTS is recommended."
}
$ConfigManager = "src\config-manager.mjs"
$ConfigEnableCommand = "enable"
$ConfigDisableCommand = "disable"
$ConfigEnabled = $false
$ServiceInstalled = $false
# The foreign-state override below is set only for a full install, but the
# finally runs for prepare-only and for failures that happen before that point
# too. Snapshot the caller's environment before any installer step can throw.
$HadForeignStateOverride = $null -ne (Get-Item Env:\MODEL_ROUTER_ALLOW_FOREIGN_STATE -ErrorAction SilentlyContinue)
$SavedForeignStateOverride = $env:MODEL_ROUTER_ALLOW_FOREIGN_STATE
$ConfigWasEnabled = $false
$ServiceWasInstalled = $false
$PythonCandidate = $null
$PythonBackup = $null
$PythonSwapStarted = $false
$PythonVenvActivated = $false
$FailedPythonVenv = $null
$AdmissionPrepared = $false
$NodeCandidate = $null
$NodeBackup = $null
$NodeActivated = $false
$FailedNodeTree = $null
$DependencySwapStarted = $false
$ServiceWasRunning = $false
$NodeModules = Join-Path $ScriptDirectory "node_modules"

function Assert-TransientPythonVenvPath([string]$Path) {
  $Root = [IO.Path]::GetFullPath($ScriptDirectory).TrimEnd([char[]]@('\', '/'))
  $Target = [IO.Path]::GetFullPath($Path)
  $Parent = [IO.Path]::GetDirectoryName($Target).TrimEnd([char[]]@('\', '/'))
  $Leaf = [IO.Path]::GetFileName($Target)
  if (-not $Parent.Equals($Root, [StringComparison]::OrdinalIgnoreCase) -or
      $Leaf -notmatch '^\.venv-(candidate|previous|failed)-[0-9a-f]{32}$') {
    throw "Unsafe transient Python environment path: $Target"
  }
  return $Target
}

function Assert-TransientNodePath([string]$Path) {
  $Root = [IO.Path]::GetFullPath($ScriptDirectory).TrimEnd([char[]]@('\', '/'))
  $Target = [IO.Path]::GetFullPath($Path)
  if (-not [IO.Path]::GetDirectoryName($Target).Equals($Root, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($Target) -notmatch '^\.node-deps-(candidate|previous|failed)-[0-9a-f]{32}$') {
    throw "Unsafe transient Node dependency path: $Target"
  }
  return $Target
}

function Get-InstallerJson([string[]]$Arguments, [string]$Label) {
  $raw = (& node @Arguments | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "$Label could not be observed; refusing dependency replacement." }
  try { return ConvertFrom-Json $raw } catch { throw "$Label returned invalid JSON; refusing dependency replacement." }
}

function Get-InstallerProcessVerdict {
  $result = Get-InstallerJson @("src\service-process.mjs", "verify", $ScriptDirectory) "Router process identity"
  if ($result.status -notin @("owned", "absent", "unknown", "foreign") -or
      $result.owned -isnot [bool] -or $result.owned -ne ($result.status -eq "owned") -or
      ($result.status -ne "owned" -and $null -ne $result.sourceRoot)) {
    throw "Router process identity is invalid or legacy; refusing dependency replacement."
  }
  if ($result.status -eq "owned" -and -not [string]::Equals(
      [IO.Path]::GetFullPath("$($result.sourceRoot)"), [IO.Path]::GetFullPath($ScriptDirectory), [StringComparison]::OrdinalIgnoreCase)) {
    throw "Router process identity names another checkout."
  }
  return $result.status
}

function Assert-InstallerListenersOffline {
  foreach ($port in @(4202, 4000)) {
    $probe = "const s=(await import('node:net')).createConnection({host:'127.0.0.1',port:Number(process.argv[1])});s.setTimeout(3000);s.on('connect',()=>{s.destroy();process.exitCode=1});s.on('timeout',()=>{s.destroy();process.exitCode=1});s.on('error',e=>{if(e.code!=='ECONNREFUSED')process.exitCode=1});"
    & node --input-type=module -e $probe $port
    if ($LASTEXITCODE -ne 0) { throw "Managed port $port is live or unknown; dependency trees were retained." }
  }
}

function Assert-InstallerProcessAbsent {
  if ((Get-InstallerProcessVerdict) -ne "absent") { throw "Router process absence is not positively established; dependency trees were retained." }
  Assert-InstallerListenersOffline
}

function Assert-InactiveDependencyPreparation {
  # Inactive rollback preparation remains service/config-free. Read ownership
  # hints without creating state; a same-checkout or unreadable record requires
  # the current process owner and both listeners to prove inactivity.
  $homeRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
  $state = if ($env:MODEL_ROUTER_STATE_DIR) { $env:MODEL_ROUTER_STATE_DIR }
    elseif ($env:CODEX_ROUTER_STATE_DIR) { $env:CODEX_ROUTER_STATE_DIR } else { Join-Path $homeRoot "codex-router" }
  $potentiallyActive = $false
  foreach ($entry in @("service-process.json", "install-manifest.json")) {
    $file = Join-Path $state $entry
    if (-not (Test-Path -LiteralPath $file -ErrorAction Stop)) { continue }
    try {
      $record = Get-Content -Raw -LiteralPath $file -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json
      $owner = if ($entry -eq "install-manifest.json") { $record.current.sourceRoot } else { $record.sourceRoot }
      if (-not [IO.Path]::IsPathRooted("$owner")) { throw "Invalid dependency preparation owner." }
      if ([string]::Equals([IO.Path]::GetFullPath($owner), [IO.Path]::GetFullPath($ScriptDirectory), [StringComparison]::OrdinalIgnoreCase)) { $potentiallyActive = $true }
    } catch { throw "Dependency preparation ownership is unknown; use a verified full installation." }
  }
  if ($potentiallyActive) {
    Assert-InstallerProcessAbsent
  }
}

function Install-NodeCandidate {
  $candidate = Assert-TransientNodePath (Join-Path $ScriptDirectory ".node-deps-candidate-$([Guid]::NewGuid().ToString('N'))")
  $script:NodeCandidate = $candidate
  New-Item -ItemType Directory -Path $candidate | Out-Null
  foreach ($name in @("package.json", "package-lock.json")) {
    Copy-Item -LiteralPath (Join-Path $ScriptDirectory $name) -Destination (Join-Path $candidate $name)
  }
  Push-Location $candidate
  try {
    & npm ci --omit=dev
    if ($LASTEXITCODE -ne 0) { throw "npm candidate dependency installation failed." }
  } finally { Pop-Location }
  & node src/install-plan.mjs verify-node $candidate
  if ($LASTEXITCODE -ne 0) { throw "The candidate Node dependency tree failed its import/input probe." }
  $relocated = Assert-TransientNodePath (Join-Path $ScriptDirectory ".node-deps-candidate-$([Guid]::NewGuid().ToString('N'))")
  Move-Item -LiteralPath $candidate -Destination $relocated
  $script:NodeCandidate = $relocated
  & node src/install-plan.mjs verify-node $relocated
  if ($LASTEXITCODE -ne 0) { throw "The relocated Node dependency tree failed its import/input probe." }
}

function Install-PinnedPythonRequirements(
  [string]$Python,
  [bool]$UseUv,
  [string]$FailureMessage
) {
  if ($UseUv) {
    & uv pip install --python $Python --require-hashes -r requirements/python.txt
  } else {
    & $Python -m pip install --require-hashes -r requirements/python.txt
  }
  if ($LASTEXITCODE -ne 0) { throw $FailureMessage }
}

# Both isolated candidates and ordinary preparation install the same locked
# environment. Activation and relocation validation remain with the caller.
function Install-PythonEnvironment([string]$Venv, [bool]$Recreate = $false) {
  $EnvironmentPython = Join-Path $Venv "Scripts\python.exe"
  $UseUv = [bool](Get-Command "uv" -ErrorAction SilentlyContinue)
  if ($UseUv) {
    if ($Recreate -or -not (Test-Path -LiteralPath $EnvironmentPython -PathType Leaf)) {
      $VenvArguments = @("venv", "--python", "3.12")
      if ($Recreate -or (Test-Path -LiteralPath $Venv)) { $VenvArguments += "--clear" }
      & uv @VenvArguments $Venv
      if ($LASTEXITCODE -ne 0) { throw "uv could not create the Python environment." }
    }
  } else {
    $LauncherArguments = @()
    if (Get-Command "py" -ErrorAction SilentlyContinue) {
      $Launcher = "py"
      $LauncherArguments = @("-3")
    } elseif (Get-Command "python" -ErrorAction SilentlyContinue) {
      $Launcher = "python"
    } else {
      throw "Python 3.10+ or uv is required. Install uv from https://docs.astral.sh/uv/."
    }
    & $Launcher @LauncherArguments -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"
    if ($LASTEXITCODE -ne 0) { throw "Python 3.10 or newer is required." }
    if ($Recreate -or -not (Test-Path -LiteralPath $EnvironmentPython -PathType Leaf)) {
      $VenvArguments = @("-m", "venv")
      if ($Recreate -or (Test-Path -LiteralPath $Venv)) { $VenvArguments += "--clear" }
      & $Launcher @LauncherArguments @VenvArguments $Venv
      if ($LASTEXITCODE -ne 0) { throw "The Python virtual environment was not created." }
    }
    if (-not (Test-Path -LiteralPath $EnvironmentPython -PathType Leaf)) {
      throw "The Python virtual environment was not created."
    }
    & $EnvironmentPython -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed." }
  }
  Install-PinnedPythonRequirements $EnvironmentPython $UseUv "LiteLLM installation failed."
}
Push-Location $ScriptDirectory

# What this run found before it changed anything, so the catch block can undo
# only what this run created. Read after Push-Location: these commands are
# resolved relative to the checkout.
function Get-InstallerStateField {
  param([string[]]$CommandArguments, [string]$Field)
  try {
    $raw = (& node @CommandArguments 2>$null | Out-String)
    if (-not $raw.Trim()) { return $null }
    return (ConvertFrom-Json $raw).$Field
  } catch {
    return $null
  }
}

try {
  if (-not $DependenciesOnly) {
    $ConfigWasEnabled = (Get-InstallerStateField @($ConfigManager, "status") "mode") -eq "router"
    $ServiceState = Get-InstallerJson @("src\service.mjs", "status") "Router service state"
    if ($ServiceState.installed -isnot [bool] -or $ServiceState.loaded -isnot [bool]) {
      throw "Router service state is incomplete; refusing dependency replacement."
    }
    $ServiceWasInstalled = $ServiceState.installed
    $ProcessStatus = Get-InstallerProcessVerdict
    if ($ProcessStatus -in @("unknown", "foreign")) { throw "Router process ownership is unresolved; refusing dependency replacement." }
    $ServiceWasRunning = $ServiceState.loaded -or $ProcessStatus -eq "owned"
    $DependencyTransaction = $ServiceWasInstalled -or $ProcessStatus -eq "owned"
  }

  & node src/install-plan.mjs verify-lock
  if ($LASTEXITCODE -ne 0) { throw "The Python dependency lock is not eligible for installation." }

  # Every update re-runs this installer, so the dependency steps are skipped
  # when their inputs are unchanged; -ForceDeps rebuilds them explicitly.
  function Get-InstallStep([string]$Step) {
    if ($ForceDeps) { return "run" }
    try {
      $Status = (& node src/install-plan.mjs status $Step 2>$null | Select-Object -Last 1)
      if ($LASTEXITCODE -ne 0) { return "run" }
      return "$Status".Trim()
    } catch {
      return "run"
    }
  }

  $NodeStep = Get-InstallStep "node-deps"
  $PythonStep = Get-InstallStep "python-deps"
  if ($DependenciesOnly -and ($NodeStep -ne "skip" -or $PythonStep -ne "skip")) { Assert-InactiveDependencyPreparation }
  if ($PrepareOnly -and $DependencyTransaction -and ($NodeStep -ne "skip" -or $PythonStep -ne "skip")) {
    throw "Active -PrepareOnly cannot replace dependency trees; use the guarded full installation."
  }
  if (-not $DependenciesOnly) {
    $CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
    New-Item -ItemType Directory -Force -Path $CodexHome | Out-Null
  }
  if (-not $PrepareOnly -and -not $DependenciesOnly) {
    & node src/provider-selection.mjs ensure-configured | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Configure at least one provider before installing." }
  }

  if ($NodeStep -eq "skip") {
    Write-Host "Node dependencies already match package-lock.json; skipping npm ci."
  } elseif ($DependencyTransaction -and -not $PrepareOnly -and -not $DependenciesOnly) {
    Install-NodeCandidate
  } else {
    & npm ci --omit=dev
    if ($LASTEXITCODE -ne 0) { throw "npm dependency installation failed." }
    & node src/install-plan.mjs record node-deps
    if ($LASTEXITCODE -ne 0) { throw "Recording the Node dependency state failed." }
  }

  $PythonVenv = Join-Path $ScriptDirectory ".venv"
  $Python = Join-Path $PythonVenv "Scripts\python.exe"
  if ($PythonStep -eq "skip") {
    Write-Host "LiteLLM already matches the pinned versions; skipping the Python install."
  } elseif ($DependencyTransaction -and -not $PrepareOnly -and -not $DependenciesOnly) {
    # Windows locks imported native Python modules. Updating the active venv in
    # place can therefore fail halfway through while LiteLLM is running. Build
    # and verify a complete replacement first; it is activated only inside the
    # service stop/start transaction below.
    $PythonCandidate = Assert-TransientPythonVenvPath (
      Join-Path $ScriptDirectory ".venv-candidate-$([Guid]::NewGuid().ToString('N'))"
    )
    $CandidatePython = Join-Path $PythonCandidate "Scripts\python.exe"
    Install-PythonEnvironment $PythonCandidate
    # Prove that the environment is relocatable before touching the live
    # service. Windows console-script launchers retain their original absolute
    # interpreter path, while the bundled runtime intentionally launches the
    # LiteLLM entry point through the moved venv's Python interpreter.
    $RelocatedPythonCandidate = Assert-TransientPythonVenvPath (
      Join-Path $ScriptDirectory ".venv-candidate-$([Guid]::NewGuid().ToString('N'))"
    )
    Move-Item -LiteralPath $PythonCandidate -Destination $RelocatedPythonCandidate
    $PythonCandidate = $RelocatedPythonCandidate
    $CandidatePython = Join-Path $PythonCandidate "Scripts\python.exe"
    & $CandidatePython -I -X utf8 -c "import encodings, fastapi, litellm, rpds, sys; assert sys.stdout.encoding.lower().replace('-', '') == 'utf8'"
    if ($LASTEXITCODE -ne 0) { throw "The candidate LiteLLM environment failed its import probe." }
    & $CandidatePython -I -X utf8 -c "from litellm import run_server; run_server()" --version | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "The relocated candidate LiteLLM entry point failed its launch probe." }
  } else {
    $VenvHomeOk = (& node src/install-plan.mjs venv-home-ok 2>$null | Select-Object -Last 1) -eq "ok"
    $VenvRuntimeOk = $false
    if (Test-Path -LiteralPath $Python -PathType Leaf) {
      & node src/install-plan.mjs venv-runtime-ok 2>$null | Out-Null
      $VenvRuntimeOk = $LASTEXITCODE -eq 0
    }
    $RecreateVenv = -not $VenvHomeOk -or -not $VenvRuntimeOk
    Install-PythonEnvironment $PythonVenv $RecreateVenv
    & node src/install-plan.mjs record python-deps
    if ($LASTEXITCODE -ne 0) { throw "Recording the Python dependency state failed." }
  }

  if ($DependenciesOnly) {
    Write-Host "Dependencies are prepared; installation state was not changed."
    return
  }

  # A live generation must agree to replacement before generated state, client
  # configuration, manifests, or active dependencies change. Candidate
  # dependency environments above are isolated and do not affect the service.
  if ($DependencyTransaction -and -not $PrepareOnly) {
    $DrainArguments = @("prepare") + $ServiceMutationArguments
    & node src/service-drain.mjs @DrainArguments
    if ($LASTEXITCODE -ne 0) { throw "Router replacement was deferred before installation state changed." }
    $AdmissionPrepared = $true
  }

  if (-not $PrepareOnly) {
    & node src/service-process.mjs assert-replacement
    if ($LASTEXITCODE -ne 0) { throw "The previous Router checkout must stop before installation ownership changes." }
  }

  # Installing is the sanctioned way for a checkout to take over a state
  # directory: the generated files below are rebuilt here and the new owner is
  # recorded before the service step, so the ownership guard must not block a
  # full install. The override is scoped to exactly that run and only after
  # -PrepareOnly is known: a -PrepareOnly run rewrites the same generated state
  # but exits before the manifest record, so letting it past the guard would
  # let a second checkout rebuild foreign-owned state with no ownership
  # transfer ever recorded. The caller's own value is restored in the finally.
  if (-not $PrepareOnly) {
    $env:MODEL_ROUTER_ALLOW_FOREIGN_STATE = "1"
  }
  & node src/secret.mjs ensure
  if ($LASTEXITCODE -ne 0) { throw "Local router-key setup failed." }
  $StateRoot = if ($env:MODEL_ROUTER_STATE_DIR) { $env:MODEL_ROUTER_STATE_DIR }
    elseif ($env:CODEX_ROUTER_STATE_DIR) { $env:CODEX_ROUTER_STATE_DIR }
    elseif ($env:CODEX_HOME) { Join-Path $env:CODEX_HOME "codex-router" }
    else { Join-Path $HOME ".codex\codex-router" }
  # The version string is not a sufficient freshness identity for Codex's
  # bundled catalog: Desktop can update catalog schema or feature-owned fields
  # without changing it. An install is the compatibility boundary, so recapture
  # the installed binary's authoritative catalog before publishing routes.
  & node src/catalog.mjs --refresh-native
  if ($LASTEXITCODE -ne 0) { throw "Codex model-catalog generation failed." }
  & node src/litellm-config.mjs
  if ($LASTEXITCODE -ne 0) { throw "Gateway configuration generation failed." }

  if ($PrepareOnly) {
    Write-Host "Dependencies and generated files are prepared; application configuration was not changed."
    # Return from the script instead of terminating the caller's PowerShell
    # host. The outer finally still has to restore the caller environment, and
    # an invoked prepare-only install must hand control back so its caller can
    # observe that restoration.
    return
  }

  $ConfigEnabled = $true
  $ConfigArguments = @($ConfigManager, $ConfigEnableCommand)
  & node @ConfigArguments
  if ($LASTEXITCODE -ne 0) { throw "$Target configuration update failed." }
  # Record before the service starts, not after. The manifest is provenance for
  # the install that just happened -- which checkout owns the state, and the
  # proxy environment a later repair must restore -- and the service itself
  # needs the record in place first: start.mjs rewrites the gateway config on
  # every boot and refuses while the manifest still names another checkout, so
  # recording after `service.mjs install` -- a step that contains the health
  # wait -- let an install over a foreign-owned state directory crash-loop for
  # the whole readiness budget while the ownership transfer never ran.
  & node src/install-manifest.mjs record | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Install-manifest recording failed." }
  if ($PythonCandidate -or $NodeCandidate) {
    & node src/service.mjs stop @ServiceMutationArguments
    $StopExit = $LASTEXITCODE
    Assert-InstallerProcessAbsent
    $DependencySwapStarted = $true
    if ($StopExit -ne 0) { throw "The running Router could not enter the dependency activation transaction." }
  }
  if ($NodeCandidate) {
    $NodeBackup = Assert-TransientNodePath (Join-Path $ScriptDirectory ".node-deps-previous-$([Guid]::NewGuid().ToString('N'))")
    if (Test-Path -LiteralPath $NodeModules -PathType Container) {
      Move-Item -LiteralPath $NodeModules -Destination $NodeBackup
    }
    Move-Item -LiteralPath (Join-Path $NodeCandidate "node_modules") -Destination $NodeModules
    $NodeActivated = $true
    & node src/install-plan.mjs record node-deps
    if ($LASTEXITCODE -ne 0) { throw "Recording the activated Node dependency state failed." }
  }
  if ($PythonCandidate) {
    $PythonBackup = Assert-TransientPythonVenvPath (
      Join-Path $ScriptDirectory ".venv-previous-$([Guid]::NewGuid().ToString('N'))"
    )
    $PythonSwapStarted = $true
    if (Test-Path -LiteralPath $PythonVenv -PathType Container) {
      Move-Item -LiteralPath $PythonVenv -Destination $PythonBackup
    }
    Move-Item -LiteralPath $PythonCandidate -Destination $PythonVenv
    $PythonCandidate = $null
    $PythonVenvActivated = $true
    & node src/install-plan.mjs record python-deps
    if ($LASTEXITCODE -ne 0) { throw "Recording the activated Python dependency state failed." }
  }
  $ServiceInstalled = $true
  & node src/service.mjs install @ServiceMutationArguments
  if ($LASTEXITCODE -ne 0) { throw "Background-service installation failed." }

  if ($NodeBackup -and (Test-Path -LiteralPath $NodeBackup -PathType Container)) {
    try {
      Remove-Item -LiteralPath (Assert-TransientNodePath $NodeBackup) -Recurse -Force
      $NodeBackup = $null
    } catch { Write-Warning "The previous inactive Node dependency tree could not be removed: $NodeBackup" }
  }

  if ($PythonBackup -and (Test-Path -LiteralPath $PythonBackup -PathType Container)) {
    try {
      Remove-Item -LiteralPath (Assert-TransientPythonVenvPath $PythonBackup) -Recurse -Force
      $PythonBackup = $null
    } catch {
      Write-Warning "The previous inactive Python environment could not be removed: $PythonBackup"
    }
  }

  # Managed Codex skills are an integration convenience, not part of router
  # health. Refresh them after the service transaction and keep a failure from
  # entering the rollback path.
  try {
    & node src/skills-install.mjs install
    $SkillsExitCode = $LASTEXITCODE
    if ($SkillsExitCode -ne 0) {
      Write-Warning "Managed Codex skills could not be refreshed (exit $SkillsExitCode); the router is installed."
    }
  } catch {
    Write-Warning "Managed Codex skills could not be refreshed; the router is installed: $($_.Exception.Message)"
  }

  Write-Host "Codex Router installation completed. Fully quit and reopen Codex to reload its model catalog."
} catch {
  $InstallFailure = $_
  if ($DependencySwapStarted) {
    try {
      # Process/listener proof does not import npm dependencies. If a damaged
      # candidate is already absent, restore the retained trees before trying
      # the service manager that needs those imports.
      $RecoveryProcess = Get-InstallerProcessVerdict
      if ($RecoveryProcess -eq "owned") {
        & node src/service.mjs stop @ServiceMutationArguments 2>$null | Out-Null
      } elseif ($RecoveryProcess -ne "absent") {
        throw "The candidate Router stoppage is unknown; dependency trees were left in place."
      }
      Assert-InstallerProcessAbsent
      if ($NodeActivated -and (Test-Path -LiteralPath $NodeModules -PathType Container)) {
        $FailedNodeTree = Assert-TransientNodePath (Join-Path $ScriptDirectory ".node-deps-failed-$([Guid]::NewGuid().ToString('N'))")
        Move-Item -LiteralPath $NodeModules -Destination $FailedNodeTree
      }
      if ($NodeBackup -and (Test-Path -LiteralPath $NodeBackup -PathType Container)) {
        Move-Item -LiteralPath (Assert-TransientNodePath $NodeBackup) -Destination $NodeModules
        $NodeBackup = $null
      }
      $FailedPythonVenv = Assert-TransientPythonVenvPath (
        Join-Path $ScriptDirectory ".venv-failed-$([Guid]::NewGuid().ToString('N'))"
      )
      if ($PythonVenvActivated -and (Test-Path -LiteralPath $PythonVenv -PathType Container)) {
        Move-Item -LiteralPath $PythonVenv -Destination $FailedPythonVenv
      }
      if ($PythonBackup -and (Test-Path -LiteralPath $PythonBackup -PathType Container)) {
        Move-Item -LiteralPath (Assert-TransientPythonVenvPath $PythonBackup) -Destination $PythonVenv
        $PythonBackup = $null
      }
      if ($ServiceWasInstalled -or $ServiceWasRunning) {
        & node src/service.mjs install @ServiceMutationArguments
        if ($LASTEXITCODE -ne 0) { throw "The previous Router service could not be restored." }
        if (-not $ServiceWasRunning) {
          & node src/service.mjs stop @ServiceMutationArguments
          if ($LASTEXITCODE -ne 0) { throw "The previous stopped Router intent could not be restored." }
          Assert-InstallerProcessAbsent
        }
      }
      if ($FailedNodeTree -and (Test-Path -LiteralPath $FailedNodeTree -PathType Container)) {
        Remove-Item -LiteralPath (Assert-TransientNodePath $FailedNodeTree) -Recurse -Force
      }
      if (Test-Path -LiteralPath $FailedPythonVenv -PathType Container) {
        Remove-Item -LiteralPath (Assert-TransientPythonVenvPath $FailedPythonVenv) -Recurse -Force
      }
    } catch {
      throw "Install failed ($($InstallFailure.Exception.Message)) and dependency rollback failed ($($_.Exception.Message)). Recovery trees: node-active=$NodeModules; node-previous=$NodeBackup; node-failed=$FailedNodeTree; python-active=$PythonVenv; python-previous=$PythonBackup; python-failed=$FailedPythonVenv."
    }
  }
  # Undo only what this run created. The router health wait can time out on a
  # cold-starting gateway with a large model set -- retryable, not broken -- and
  # tearing out a service and disabling a client config that were both working
  # before the run turns that into an unrouted machine.
  if ($ServiceInstalled -and -not $ServiceWasInstalled) {
    & node src/service.mjs uninstall @ServiceMutationArguments 2>$null | Out-Null
  }
  if ($ConfigEnabled) {
    if (-not $ConfigWasEnabled) {
      & node $ConfigManager $ConfigDisableCommand 2>$null | Out-Null
    }
  }
  throw $InstallFailure
} finally {
  if ($AdmissionPrepared) {
    & node src/service-drain.mjs resume 2>$null | Out-Null
  }
  if ($PythonCandidate -and (Test-Path -LiteralPath $PythonCandidate -PathType Container)) {
    Remove-Item -LiteralPath (Assert-TransientPythonVenvPath $PythonCandidate) -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($NodeCandidate -and (Test-Path -LiteralPath $NodeCandidate -PathType Container)) {
    Remove-Item -LiteralPath (Assert-TransientNodePath $NodeCandidate) -Recurse -Force -ErrorAction SilentlyContinue
  }
  # Restore the caller's environment exactly as it was found: a value this run
  # did not set is removed, and a pre-existing one is put back verbatim. The
  # scoped override must never outlive the install process that justified it.
  if ($HadForeignStateOverride) {
    $env:MODEL_ROUTER_ALLOW_FOREIGN_STATE = $SavedForeignStateOverride
  } else {
    Remove-Item Env:\MODEL_ROUTER_ALLOW_FOREIGN_STATE -ErrorAction SilentlyContinue
  }
  Pop-Location
}
