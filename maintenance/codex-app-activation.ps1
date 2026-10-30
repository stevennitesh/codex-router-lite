# Opt-in completion of this maintenance workflow uses the current registered
# desktop app. No executable/cache selection, launch arguments or startup hook.
function Get-CodexMaintenanceReopenIdentity {
  $packages = @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop)
  if ($packages.Count -ne 1 -or $packages[0].Name -cne 'OpenAI.Codex') { throw 'Codex desktop registration is missing or ambiguous.' }
  $package = $packages[0]
  $manifest = Get-AppxPackageManifest -Package $package.PackageFullName -ErrorAction Stop
  $registered = @(Get-StartApps -ErrorAction Stop | Where-Object { $_.AppID -like "$($package.PackageFamilyName)!*" })
  $matches = @($manifest.Package.Applications.Application | Where-Object {
    $id = "$($package.PackageFamilyName)!$($_.Id)"
    $_.EntryPoint -eq 'Windows.FullTrustApplication' -and
      [IO.Path]::GetFileName([string]$_.Executable) -match '^(?:Codex|ChatGPT)\.exe$' -and
      @($registered | Where-Object { $_.AppID -ceq $id }).Count -eq 1
  })
  if ($matches.Count -ne 1 -or -not [IO.Path]::IsPathRooted([string]$package.InstallLocation)) { throw 'Codex desktop application registration is missing or ambiguous.' }
  $app = $matches[0]
  [pscustomobject][ordered]@{
    version = 1
    sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
    packageFullName = [string]$package.PackageFullName
    packageFamilyName = [string]$package.PackageFamilyName
    publisherId = [string]$package.PublisherId
    applicationId = [string]$app.Id
    aumid = "$($package.PackageFamilyName)!$($app.Id)"
    executable = [string]$app.Executable
    installLocation = [string]$package.InstallLocation
    manifestSha256 = (Get-FileHash -LiteralPath (Join-Path $package.InstallLocation 'AppxManifest.xml') -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
  }
}

function Invoke-CodexMaintenanceRegisteredActivation([string]$Aumid) {
  if (-not ('CodexRouterMaintenance.RegisteredActivation' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace CodexRouterMaintenance {
  [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IApplicationActivationManager {
    [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string id,
      [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint processId);
  }
  [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
  class ApplicationActivationManager { }
  public static class RegisteredActivation {
    public static uint Activate(string id) {
      var instance = new ApplicationActivationManager();
      try {
        uint pid;
        // AO_NOERRORUI suppresses activation-error dialogs. It changes no app
        // arguments, debug mode, browser selection or authentication behavior.
        int status = ((IApplicationActivationManager)instance).ActivateApplication(id, "", 2, out pid);
        Marshal.ThrowExceptionForHR(status);
        if (pid == 0) throw new InvalidOperationException("Application activation returned no process.");
        return pid;
      } finally { Marshal.ReleaseComObject(instance); }
    }
  }
}
'@
  }
  return [CodexRouterMaintenance.RegisteredActivation]::Activate($Aumid)
}

function Complete-CodexMaintenanceReopen([object]$Expected, [string]$ResultPath) {
  $outcome = [ordered]@{ requested = $true; attempted = $false; succeeded = $false; status = 'failed'; failure = 'success-not-durable' }
  try {
    $completed = Get-Content -LiteralPath $ResultPath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json
    if ($completed.state -ne 'completed' -or $completed.succeeded -ne $true -or $completed.acceptance.accepted -ne $true) { return [pscustomobject]$outcome }
    $outcome.failure = 'registration-unavailable'
    $current = Get-CodexMaintenanceReopenIdentity
    $outcome.failure = 'interactive-session-mismatch'
    if ($current.sessionId -lt 1 -or $current.sessionId -ne $Expected.sessionId) { return [pscustomobject]$outcome }
    $fields = @('version', 'sessionId', 'packageFullName', 'packageFamilyName', 'publisherId', 'applicationId', 'aumid', 'executable', 'installLocation', 'manifestSha256')
    $outcome.failure = 'registration-changed'
    if ($Expected.version -ne 1 -or @($Expected.PSObject.Properties).Count -ne $fields.Count -or
        @($fields | Where-Object { $Expected.$_ -cne $current.$_ }).Count) { return [pscustomobject]$outcome }
    $outcome.attempted = $true
    $outcome.status = 'attempting'
    $outcome.failure = 'attempt-not-durable'
    $completed | Add-Member -NotePropertyName reopen -NotePropertyValue ([pscustomobject]$outcome) -Force
    Write-DeploymentJson $ResultPath $completed
    $outcome.status = 'failed'
    $outcome.failure = 'activation-failed'
    $processId = Invoke-CodexMaintenanceRegisteredActivation $current.aumid
    if (-not $processId -or [long]$processId -lt 1) { return [pscustomobject]$outcome }
    $outcome.status = 'activated'; $outcome.succeeded = $true; $outcome.failure = $null
    $outcome['processId'] = [long]$processId
  } catch { # App activation failure never changes accepted software/rollback custody.
    $outcome.status = 'failed'
    if ($outcome.failure -eq 'attempt-not-durable') { $outcome.attempted = $false }
  }
  return [pscustomobject]$outcome
}
