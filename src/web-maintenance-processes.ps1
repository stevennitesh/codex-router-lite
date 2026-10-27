$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.action -eq 'census') {
    # Query the full candidate set. An inaccessible generation is unknown;
    # enumeration and property errors must never look like an empty census.
    $rows = @()
    $candidates = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    foreach ($candidate in $candidates) {
      $identity = $null
      $probeState = 'unknown'
      $executablePath = $candidate.ExecutablePath
      $process = $null
      $again = $null
      # System/foreign processes can conceal executable properties. Retain the
      # row and ancestry so any matching or descendant unknown fails closed.
      # Every observed executable is checked against both complete cohort roots,
      # including official helper names added by future app versions.
      try {
        $process = Get-Process -Id $candidate.ProcessId -ErrorAction Stop
        $probeState = 'alive'
        if ($process.HasExited) { $probeState = 'absent' }
        elseif ($process.Path) {
            $identity = $process.StartTime.ToUniversalTime().Ticks.ToString() + '|' + $process.Path
            if (-not $executablePath) { $executablePath = $process.Path }
            $again = Get-Process -Id $candidate.ProcessId -ErrorAction Stop
            if ($again.HasExited) { $identity = $null; $probeState = 'absent' }
            elseif ($identity -ne ($again.StartTime.ToUniversalTime().Ticks.ToString() + '|' + $again.Path)) { $identity = $null; $probeState = 'unknown' }
        }
      } catch {
        $identity = $null
        if ($_.FullyQualifiedErrorId -match '^NoProcessFoundForGivenId(?:,|$)') { $probeState = 'absent' }
        else {
          $probeState = 'unknown'
          # A denied property and a generation that exited during inspection
          # are different observations. Only positive absence permits omission.
          try { $again = Get-Process -Id $candidate.ProcessId -ErrorAction Stop; if ($again.HasExited) { $probeState = 'absent' } }
          catch { if ($_.FullyQualifiedErrorId -match '^NoProcessFoundForGivenId(?:,|$)') { $probeState = 'absent' } }
        }
      } finally {
        if ($process) { $process.Dispose() }
        if ($again) { $again.Dispose() }
      }
      $service = $null
      if ($candidate.Name -ieq 'codex-windows-sandbox-service.exe' -and $probeState -ne 'absent') {
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
    $budget = [int]$request.timeoutMs
    if ($budget -lt 1 -or $budget -gt 60000) { throw 'Invalid exit wait budget.' }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    foreach ($generation in $request.processes) {
      try { $process = Get-Process -Id $generation.pid -ErrorAction Stop }
      catch {
        if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId,*') { continue }
        throw
      }
      try {
        # Opening Handle before checking identity retains this exact generation
        # through exit, including PID reuse. This never signals a process.
        $null = $process.Handle
        $identity = $process.StartTime.ToUniversalTime().Ticks.ToString() + '|' + $process.Path
        if (-not $process.Path) { throw 'Incomplete process identity.' }
        if ($identity -ne $generation.identity) { continue }
        $remaining = [Math]::Max(0, $budget - [int]$clock.ElapsedMilliseconds)
        if (-not $process.WaitForExit($remaining)) { break }
      } finally { $process.Dispose() }
    }
    [Console]::Out.Write('{"waited":true}')
  } else { throw 'Unknown process inspection action.' }
} catch {
  [Console]::Error.Write('Web maintenance process inspection could not establish complete process identities.')
  exit 1
}
