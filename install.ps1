[CmdletBinding()]
param(
  [switch]$CheckoutInstall,
  [switch]$PrepareOnly,
  [switch]$ForceDeps,
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
if ($NoProvider -and $Providers) {
  throw "-NoProvider cannot be combined with -Providers."
}
$PreviousRevision = $null
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
    return (Get-Content $Package -Raw | ConvertFrom-Json).name -eq "codex-router-lite"
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

# The installed service uses a Windows Job Object so every child is contained.
# Prove the PowerShell capabilities needed to create it before cloning, pulling,
# installing dependencies, changing configuration, or touching service state.
Assert-WindowsProcessContainmentCapability

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
      $Origin = (& git -C $InstallDir remote get-url origin).Trim()
      $AllowedOrigins = @(
        $RepositoryUrl,
        "https://github.com/stevennitesh/codex-router-lite",
        "https://github.com/stevennitesh/codex-router-lite.git",
        "git@github.com:stevennitesh/codex-router-lite.git"
      ) | Where-Object { $_ }
      if ($Origin -notin $AllowedOrigins) {
        throw "$InstallDir has an unrecognized origin and will not be updated: $Origin"
      }
      # PowerShell unrolls a one-element array on return, so re-wrap before
      # reading .Count.
      $Dirty = @(Get-LocalModification $InstallDir)
      if ($Dirty.Count) {
        if (-not $Force) { throw (Get-LocalModificationMessage $Dirty $InstallDir) }
        Reset-ManagedCheckout $InstallDir
      }
      # A failed setup rolls the checkout back to a detached HEAD (see the
      # rollback below), where `branch --show-current` prints nothing. A native
      # command with no output yields $null, and in Windows PowerShell 5.1
      # [string]$null stays $null, so guard explicitly before calling Trim().
      $Branch = & git -C $InstallDir branch --show-current
      if ($null -eq $Branch) { $Branch = "" }
      $Branch = [string]$Branch.Trim()
      if ($Branch -ne "main") {
        if (-not $Branch) {
          & git -C $InstallDir switch main 2>$null
          if ($LASTEXITCODE -ne 0) {
            throw "$InstallDir is in a detached HEAD state and could not be restored to main; run 'git switch main' there and retry."
          }
          $Branch = & git -C $InstallDir branch --show-current
          if ($null -eq $Branch) { $Branch = "" }
          $Branch = [string]$Branch.Trim()
        }
        if ($Branch -ne "main") { throw "$InstallDir must be on its main branch to update." }
      }
      $PreviousRevision = (& git -C $InstallDir rev-parse HEAD).Trim()
      & git -C $InstallDir update-ref refs/codex-router/rollback $PreviousRevision
      & git -C $InstallDir pull --ff-only origin main
      if ($LASTEXITCODE -ne 0) { throw "Unable to fast-forward the managed checkout." }
    } elseif (Test-Path $InstallDir) {
      throw "$InstallDir exists and is not a Codex Router checkout."
    } else {
      New-Item -ItemType Directory -Force -Path (Split-Path $InstallDir) | Out-Null
      & git clone --depth 1 $RepositoryUrl $InstallDir
      if ($LASTEXITCODE -ne 0) { throw "Unable to clone Codex Router." }
    }
    $Repository = $InstallDir
  }

  if ($PrepareOnly) {
    & (Join-Path $Repository "install.ps1") -CheckoutInstall -PrepareOnly -Target codex
    exit $LASTEXITCODE
  }

  if ($Providers) {
    $NamedProviders = @($Providers.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $Unsupported = @($NamedProviders | Where-Object { $_ -notin @("openrouter", "switchyard") })
    if ($Unsupported.Count -gt 0) { throw "Unsupported provider(s): $($Unsupported -join ', ')." }
    & node (Join-Path $Repository "src\provider-selection.mjs") set @NamedProviders | Out-Null
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  } elseif ($NoProvider) {
    & node (Join-Path $Repository "src\provider-selection.mjs") set | Out-Null
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  & (Join-Path $Repository "install.ps1") -CheckoutInstall -Target codex -ForceDeps:$ForceDeps
  exit $LASTEXITCODE
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
  $ConfigWasEnabled = (Get-InstallerStateField @($ConfigManager, "status") "mode") -eq "router"
  $ServiceWasInstalled = (Get-InstallerStateField @("src\service.mjs", "status") "installed") -eq $true
  $CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
  New-Item -ItemType Directory -Force -Path $CodexHome | Out-Null
  if (-not $PrepareOnly) {
    & node src/provider-selection.mjs ensure-configured | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Configure at least one provider before installing." }
  }

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

  if ((Get-InstallStep "node-deps") -eq "skip") {
    Write-Host "Node dependencies already match package-lock.json; skipping npm ci."
  } else {
    & npm ci --omit=dev
    if ($LASTEXITCODE -ne 0) { throw "npm dependency installation failed." }
    & node src/install-plan.mjs record node-deps
    if ($LASTEXITCODE -ne 0) { throw "Recording the Node dependency state failed." }
  }

  $Python = Join-Path $ScriptDirectory ".venv\Scripts\python.exe"
  if ((Get-InstallStep "python-deps") -eq "skip") {
    Write-Host "LiteLLM already matches the pinned versions; skipping the Python install."
  } elseif (Get-Command "uv" -ErrorAction SilentlyContinue) {
    $VenvHomeOk = (& node src/install-plan.mjs venv-home-ok 2>$null | Select-Object -Last 1) -eq "ok"
    $VenvRuntimeOk = $false
    if (Test-Path $Python) {
      try {
        & $Python -I -c "import encodings, sys" 2>$null | Out-Null
        $VenvRuntimeOk = $LASTEXITCODE -eq 0
      } catch {
        $VenvRuntimeOk = $false
      }
    }
    if (-not (Test-Path $Python)) {
      if (Test-Path ".venv") {
        Write-Host "The virtual environment's Python launcher is missing; recreating the venv."
        & uv venv --clear --python 3.12 .venv
      } else {
        & uv venv --python 3.12 .venv
      }
      if ($LASTEXITCODE -ne 0) { throw "uv could not create the Python environment." }
    } elseif (-not $VenvHomeOk -or -not $VenvRuntimeOk) {
      # A venv whose recorded interpreter home disappeared must be recreated,
      # not pip-installed into: the launcher may still exist while pyvenv.cfg
      # points at a vanished home.
      Write-Host "The virtual environment's interpreter home is missing; recreating the venv."
      & uv venv --clear --python 3.12 .venv
      if ($LASTEXITCODE -ne 0) { throw "uv could not create the Python environment." }
    }
    # requirements/python.txt is the hash-verified transitive closure of the
    # pins in src/install-plan.mjs. Hash checking makes every wheel and sdist
    # in that tree verify against the lock before it is executed; without it
    # only the two top-level packages were pinned and the rest was whatever
    # PyPI resolved that day. Regenerate with the documented uv command, never
    # by editing the compiled lock.
    & uv pip install --python $Python --require-hashes -r requirements/python.txt
    if ($LASTEXITCODE -ne 0) { throw "LiteLLM installation failed." }
    & node src/install-plan.mjs record python-deps
    if ($LASTEXITCODE -ne 0) { throw "Recording the Python dependency state failed." }
  } else {
    $VenvHomeOk = (& node src/install-plan.mjs venv-home-ok 2>$null | Select-Object -Last 1) -eq "ok"
    $VenvRuntimeOk = $false
    if (Test-Path $Python) {
      try {
        & $Python -I -c "import encodings, sys" 2>$null | Out-Null
        $VenvRuntimeOk = $LASTEXITCODE -eq 0
      } catch {
        $VenvRuntimeOk = $false
      }
    }
    $RecreateVenv = -not $VenvHomeOk -or -not $VenvRuntimeOk
    if (Get-Command "py" -ErrorAction SilentlyContinue) {
      & py -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"
      if ($LASTEXITCODE -ne 0) { throw "Python 3.10 or newer is required." }
      if (-not (Test-Path $Python)) {
        & py -3 -m venv .venv
      } elseif ($RecreateVenv) {
        Write-Host "The virtual environment's interpreter home is missing; recreating the venv."
        & py -3 -m venv --clear .venv
      }
    } elseif (Get-Command "python" -ErrorAction SilentlyContinue) {
      & python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"
      if ($LASTEXITCODE -ne 0) { throw "Python 3.10 or newer is required." }
      if (-not (Test-Path $Python)) {
        & python -m venv .venv
      } elseif ($RecreateVenv) {
        Write-Host "The virtual environment's interpreter home is missing; recreating the venv."
        & python -m venv --clear .venv
      }
    } else {
      throw "Python 3.10+ or uv is required. Install uv from https://docs.astral.sh/uv/."
    }
    if (-not (Test-Path $Python)) { throw "The Python virtual environment was not created." }
    & $Python -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed." }
    # Same hash-verified lock as the uv branch above; both stay hash-checked.
    & $Python -m pip install --require-hashes -r requirements/python.txt
    if ($LASTEXITCODE -ne 0) { throw "LiteLLM installation failed." }
    & node src/install-plan.mjs record python-deps
    if ($LASTEXITCODE -ne 0) { throw "Recording the Python dependency state failed." }
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
  $ServiceInstalled = $true
  & node src/service.mjs install
  if ($LASTEXITCODE -ne 0) { throw "Background-service installation failed." }
  & node src/wait-health.mjs
  if ($LASTEXITCODE -ne 0) { throw "The router did not become healthy." }

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

  Write-Host "Installed the selected external model routes. Fully quit and reopen Codex."
} catch {
  # Undo only what this run created. The router health wait can time out on a
  # cold-starting gateway with a large model set -- retryable, not broken -- and
  # tearing out a service and disabling a client config that were both working
  # before the run turns that into an unrouted machine.
  if ($ServiceInstalled -and -not $ServiceWasInstalled) {
    & node src/service.mjs uninstall 2>$null | Out-Null
  }
  if ($ConfigEnabled) {
    if (-not $ConfigWasEnabled) {
      & node $ConfigManager $ConfigDisableCommand 2>$null | Out-Null
    }
  }
  throw
} finally {
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
