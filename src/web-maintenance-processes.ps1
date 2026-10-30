$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$failurePhase = 'request'
$failureReason = 'invalid-request'
$failureRole = 'none'

function Get-WebMaintenanceProcess {
  [CmdletBinding()]param([int]$Id)
  # Open by ID directly. Only this native open's missing-PID exception is
  # positive absence; property/handle exceptions elsewhere remain unknown.
  try { return [Diagnostics.Process]::GetProcessById($Id) }
  catch [ArgumentException] {
    $PSCmdlet.ThrowTerminatingError([Management.Automation.ErrorRecord]::new(
      [ArgumentException]::new('Process ID is absent.'), 'NoProcessFoundForGivenId',
      [Management.Automation.ErrorCategory]::ObjectNotFound, $Id))
  }
}

function Get-WebMaintenanceExitState([int]$ProcessId, [object]$Observed, [string]$ExpectedIdentity) {
  # Property/handle access can lose a process after successful lookup. A live
  # unreadable generation is still unknown; only an actual exit, positive PID
  # absence or a fully identified replacement settles the recorded generation.
  try { if ($Observed -and $Observed.HasExited) { return 'exited' } } catch {}
  $current = $null
  try {
    $current = Get-WebMaintenanceProcess -Id $ProcessId -ErrorAction Stop
    if ($current.HasExited) { return 'exited' }
    if ($ExpectedIdentity) {
      $currentPath = $current.Path
      if ($currentPath) {
        $identity = $current.StartTime.ToUniversalTime().Ticks.ToString() + '|' + $currentPath
        if ($identity -ne $ExpectedIdentity) { return 'replaced' }
      }
    }
  } catch {
    if ($_.FullyQualifiedErrorId -match '^NoProcessFoundForGivenId(?:,|$)') { return 'absent' }
    try { if ($current -and $current.HasExited) { return 'exited' } } catch {}
  } finally { if ($current) { $current.Dispose() } }
  return 'unknown'
}

function Get-WebMaintenanceProcessRole([string]$Name) {
  if ($Name -match '^(?:Codex|ChatGPT)\.exe$') { return 'native-host' }
  if ($Name -match '^codex.*\.exe$') { return 'official-helper' }
  if ($Name -eq 'node_repl.exe') { return 'official-repl' }
  if ($Name -match '^(?:node|entry)\.exe$') { return 'node-or-adapter' }
  return 'descendant'
}

try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.action -eq 'census') {
    $failurePhase = 'census'
    $failureReason = 'invalid-scope'
    $scope = $request.scope
    if (-not $scope -or $scope.ownPid -isnot [int] -or $scope.ownPid -lt 1 -or
        $scope.roots -isnot [array] -or $scope.roots.Count -lt 1) { throw 'Invalid census scope.' }
    $roots = @($scope.roots | ForEach-Object {
      if ($_ -isnot [string] -or [string]::IsNullOrWhiteSpace($_) -or $_.Contains([char]0) -or
          -not [IO.Path]::IsPathRooted($_) -or [IO.Path]::GetFullPath($_) -ine $_) { throw 'Invalid census root.' }
      $_.ToLowerInvariant()
    })
    $failureReason = 'enumeration-failed'
    # Query the full candidate set. An inaccessible generation is unknown;
    # enumeration and property errors must never look like an empty census.
    $rows = @()
    $candidates = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    # Keep every CIM row and every ancestry edge. Native generation inspection
    # is unnecessary only when the snapshot positively identifies an unrelated
    # executable and command. Missing metadata, generic runtimes and descendants
    # of any candidate always retain both native generation observations.
    $inspect = [Collections.Generic.HashSet[int]]::new()
    foreach ($candidate in $candidates) {
      $executable = $candidate.ExecutablePath
      $command = $candidate.CommandLine
      $identified = $executable -is [string] -and -not [string]::IsNullOrWhiteSpace($executable) -and
        [IO.Path]::IsPathRooted($executable) -and $command -is [string] -and -not [string]::IsNullOrWhiteSpace($command)
      if ($identified) {
        try { $executable = [IO.Path]::GetFullPath($executable).ToLowerInvariant() }
        catch { $identified = $false }
      }
      $matches = $candidate.ProcessId -eq $scope.ownPid -or $candidate.Name -match '^(?:codex(?:[-_].*)?|chatgpt|node_repl|node|entry)\.exe$' -or -not $identified
      if (-not $matches) {
        $command = $command.ToLowerInvariant().Replace('/', '\')
        foreach ($root in $roots) {
          $prefix = if ($root.EndsWith('\')) { $root } else { $root + '\' }
          if ($executable.StartsWith($prefix, [StringComparison]::Ordinal) -or $command.Contains($root)) { $matches = $true; break }
        }
      }
      if ($matches) { $null = $inspect.Add([int]$candidate.ProcessId) }
    }
    do {
      $advanced = $false
      foreach ($candidate in $candidates) {
        # Zero is the no-parent sentinel, not ancestry beneath the idle row.
        if ($candidate.ParentProcessId -ne 0 -and $inspect.Contains([int]$candidate.ParentProcessId) -and $inspect.Add([int]$candidate.ProcessId)) { $advanced = $true }
      }
    } while ($advanced)
    foreach ($candidate in $candidates) {
      $failureReason = 'row-inspection-failed'
      $failureRole = Get-WebMaintenanceProcessRole $candidate.Name
      $identity = $null
      $probeState = 'unknown'
      $executablePath = $candidate.ExecutablePath
      $process = $null
      $again = $null
      # System/foreign processes can conceal executable properties. Retain the
      # row and ancestry so any matching or descendant unknown fails closed.
      if ($inspect.Contains([int]$candidate.ProcessId)) {
        try {
          $process = Get-WebMaintenanceProcess -Id $candidate.ProcessId -ErrorAction Stop
          $probeState = 'alive'
          if ($process.HasExited) { $probeState = 'absent' }
          else {
            $nativePath = $process.Path
            if (-not $nativePath) { $probeState = 'unknown' }
            else {
              $identity = $process.StartTime.ToUniversalTime().Ticks.ToString() + '|' + $nativePath
              if (-not $executablePath) { $executablePath = $nativePath }
              $again = Get-WebMaintenanceProcess -Id $candidate.ProcessId -ErrorAction Stop
              if ($again.HasExited) { $identity = $null; $probeState = 'absent' }
              else {
                $againPath = $again.Path
                if (-not $againPath -or $identity -ne ($again.StartTime.ToUniversalTime().Ticks.ToString() + '|' + $againPath)) { $identity = $null; $probeState = 'unknown' }
              }
            }
          }
        } catch {
          $identity = $null
          if ($_.FullyQualifiedErrorId -match '^NoProcessFoundForGivenId(?:,|$)') { $probeState = 'absent' }
          else {
            $probeState = 'unknown'
            # A denied property and a generation that exited during inspection
            # are different observations. Only positive absence permits omission.
            if ((Get-WebMaintenanceExitState $candidate.ProcessId $process '') -in @('exited', 'absent')) { $probeState = 'absent' }
          }
        } finally {
          if ($process) { $process.Dispose() }
          if ($again) { $again.Dispose() }
        }
      }
      $service = $null
      if ($candidate.Name -ieq 'codex-windows-sandbox-service.exe' -and $probeState -ne 'absent') {
        $failureReason = 'broker-inspection-failed'
        $failureRole = 'official-helper'
        $registered = @(Get-CimInstance Win32_Service -Filter "ProcessId = $($candidate.ProcessId)" -ErrorAction Stop)
        if ($registered.Count -eq 1 -and $registered[0].Name -ceq 'CodexSandboxService.OpenAI.Codex') {
          $owner = $registered[0]
          $registration = Get-ItemProperty -LiteralPath (Join-Path 'HKLM:\SYSTEM\CurrentControlSet\Services' $owner.Name) -ErrorAction Stop
          $verified = @(Get-CimInstance Win32_Service -Filter "Name = 'CodexSandboxService.OpenAI.Codex'" -ErrorAction Stop)
          if ($verified.Count -eq 1 -and $verified[0].ProcessId -eq $owner.ProcessId -and $verified[0].PathName -ceq $owner.PathName -and
              $verified[0].StartName -ceq $owner.StartName -and $verified[0].State -eq 'Running') {
            $service = @{ name = $owner.Name; processId = [int]$owner.ProcessId; startName = $owner.StartName; state = $verified[0].State;
              configuredImagePath = $owner.PathName; registeredImagePath = $registration.ImagePath; registryType = [int]$registration.Type;
              registryAccount = $registration.ObjectName; packageFullName = $registration.PackageFullName }
          }
        }
      }
      $rows += @{ pid = [int]$candidate.ProcessId; parentPid = [int]$candidate.ParentProcessId; name = [string]$candidate.Name;
        sessionId = [int]$candidate.SessionId; probeState = $probeState; service = $service;
        executablePath = $executablePath; identity = $identity; commandLine = $candidate.CommandLine }
    }
    [Console]::Out.Write((@{ complete = $true; processes = @($rows) } | ConvertTo-Json -Depth 5 -Compress))
  } elseif ($request.action -eq 'wait') {
    $failurePhase = 'wait'
    $failureReason = 'invalid-budget'
    $budget = [int]$request.timeoutMs
    if ($budget -lt 1 -or $budget -gt 60000) { throw 'Invalid exit wait budget.' }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    foreach ($generation in $request.processes) {
      $failureRole = Get-WebMaintenanceProcessRole $generation.name
      $failureReason = 'process-open-unknown'
      try { $process = Get-WebMaintenanceProcess -Id $generation.pid -ErrorAction Stop }
      catch {
        if ($_.FullyQualifiedErrorId -match '^NoProcessFoundForGivenId(?:,|$)') { continue }
        throw
      }
      try {
        # Opening Handle before checking identity retains this exact generation
        # through exit, including PID reuse. This never signals a process.
        $failureReason = 'handle-open-unknown'
        $null = $process.Handle
        $failureReason = 'identity-read-unknown'
        $nativePath = $process.Path
        if (-not $nativePath) { throw 'Incomplete process identity.' }
        $identity = $process.StartTime.ToUniversalTime().Ticks.ToString() + '|' + $nativePath
        if ($identity -ne $generation.identity) { continue }
        $remaining = [Math]::Max(0, $budget - [int]$clock.ElapsedMilliseconds)
        $failureReason = 'exit-wait-unknown'
        if (-not $process.WaitForExit($remaining)) { break }
      } catch {
        if ((Get-WebMaintenanceExitState $generation.pid $process $generation.identity) -in @('exited', 'absent', 'replaced')) { continue }
        throw
      } finally { $process.Dispose() }
    }
    [Console]::Out.Write('{"waited":true}')
  } else { throw 'Unknown process inspection action.' }
} catch {
  [Console]::Error.Write((@{ phase = $failurePhase; reason = $failureReason; role = $failureRole } | ConvertTo-Json -Compress))
  exit 1
}
