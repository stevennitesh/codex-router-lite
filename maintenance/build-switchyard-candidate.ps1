[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$configRoot = Join-Path $repoRoot "config\switchyard"
$lock = Get-Content -Raw -LiteralPath (Join-Path $configRoot "source.lock") | ConvertFrom-Json
if ($lock.repository -notmatch '^https://github\.com/[^/]+/[^/]+(?:\.git)?$' -or
    $lock.commit -notmatch '^[0-9a-f]{40}$' -or
    $lock.rustToolchain -notmatch '^\d+\.\d+\.\d+$') {
  throw "Switchyard source.lock has an invalid repository, commit, or toolchain."
}

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
  & $Command @Arguments | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "$Command exited with status $LASTEXITCODE." }
}

function Get-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }
  finally { $hasher.Dispose(); $stream.Dispose() }
}

function Resolve-Child([string]$Parent, [string]$Relative) {
  if ([string]::IsNullOrWhiteSpace($Relative) -or [IO.Path]::IsPathRooted($Relative)) {
    throw "Expected a relative Switchyard artifact path."
  }
  $prefix = [IO.Path]::GetFullPath($Parent).TrimEnd([char[]]@('\', '/')) + [IO.Path]::DirectorySeparatorChar
  $resolved = [IO.Path]::GetFullPath((Join-Path $Parent $Relative))
  if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Switchyard artifact leaves its owning directory."
  }
  return $resolved
}

$patches = @(
  @{ Path = $lock.upstreamContribution.patch; Hash = $lock.upstreamContribution.patchSha256 },
  @{ Path = $lock.patch; Hash = $lock.patchSha256 }
)
foreach ($patch in $patches) {
  $patch.Path = Resolve-Child $configRoot $patch.Path
  if ($patch.Hash -notmatch '^[0-9a-f]{64}$' -or
      (Get-Sha256 $patch.Path) -ne $patch.Hash) {
    throw "Switchyard patch hash does not match source.lock."
  }
}

$tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([char[]]@('\', '/'))
$buildRoot = Resolve-Child $tempParent ("switchyard-build-" + [Guid]::NewGuid().ToString('N'))
$candidateBinary = Resolve-Child $buildRoot $lock.binary
if (Test-Path -LiteralPath $buildRoot) { throw "Switchyard build directory already exists." }
$completed = $false
try {
  Invoke-Checked "git" @("clone", "--filter=blob:none", "--no-checkout", $lock.repository, $buildRoot)
  Invoke-Checked "git" @("-C", $buildRoot, "checkout", "--detach", $lock.commit)
  foreach ($patch in $patches) {
    Invoke-Checked "git" @("-C", $buildRoot, "apply", "--check", $patch.Path)
    Invoke-Checked "git" @("-C", $buildRoot, "apply", $patch.Path)
  }
  Invoke-Checked "rustup" @("toolchain", "install", $lock.rustToolchain, "--profile", "minimal")
  Invoke-Checked "rustup" @("component", "add", "--toolchain", $lock.rustToolchain, "rustfmt", "clippy")
  Push-Location -LiteralPath $buildRoot
  try {
    $cargo = @("run", $lock.rustToolchain, "cargo")
    Invoke-Checked "rustup" ($cargo + @("fmt", "--all", "--check"))
    Invoke-Checked "rustup" ($cargo + @("clippy", "--locked", "--workspace", "--all-targets", "--", "-D", "warnings"))
    Invoke-Checked "rustup" ($cargo + @("test", "--locked", "-p", "switchyard-llm-client", "-p", "switchyard-libsy", "-p", "switchyard-runner", "-p", "switchyard-server", "-p", "switchyard-translation", "-p", "switchyard-typesafe-client"))
    Invoke-Checked "rustup" ($cargo + @("build", "--locked", "--release", "-p", "switchyard-server"))
  } finally { Pop-Location }
  $candidateHash = Get-Sha256 $candidateBinary
  $completed = $true
  [pscustomobject]@{ buildRoot = $buildRoot; candidateBinary = $candidateBinary; candidateHash = $candidateHash; upstreamCommit = $lock.commit }
} finally {
  if (-not $completed -and (Test-Path -LiteralPath $buildRoot)) {
    # Delete only this invocation's direct-child disposable checkout.
    if (-not [string]::Equals([IO.Path]::GetDirectoryName($buildRoot), $tempParent, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Unsafe Switchyard build cleanup path: $buildRoot"
    }
    Remove-Item -LiteralPath $buildRoot -Recurse -Force
  }
}
