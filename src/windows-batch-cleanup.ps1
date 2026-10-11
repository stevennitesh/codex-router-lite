param(
    [Parameter(Mandatory)][int]$RootPid,
    [Parameter(Mandatory)][int]$ParentPid,
    [Parameter(Mandatory)][long]$LaunchedAfterMs,
    [Parameter(Mandatory)][long]$LaunchedBeforeMs,
    [Parameter(Mandatory)][string]$ExpectedExecutable,
    [Parameter(Mandatory)][long]$DeadlineMs
)

$ErrorActionPreference = 'Stop'
$owned = @{}
$nativeCode = $null
$proofAvailable = $false

function Remaining-Time {
    $remaining = $DeadlineMs - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($remaining -le 0) { throw 'Windows child cleanup deadline expired.' }
    return [int][Math]::Min($remaining, [int]::MaxValue)
}

function Capture-Process($row) {
    $candidate = [Diagnostics.Process]::GetProcessById([int]$row.ProcessId)
    try {
        # Force a native handle now; later waits refer to this generation even
        # after it exits. Retaining the handle also prevents its PID being reused.
        $null = $candidate.Handle
        $created = $candidate.StartTime.ToUniversalTime().Ticks
        # Win32_Process stores microseconds; native process time has 100ns ticks.
        $observed = $row.CreationDate.ToUniversalTime().Ticks
        if (($created - $observed) -lt 0 -or ($created - $observed) -gt 9) {
            throw 'Windows child process generation changed during capture.'
        }
        return @{ process = $candidate; created = $created; parent = [int]$row.ParentProcessId }
    } catch {
        $candidate.Dispose()
        throw
    }
}

function Capture-Descendants($rows) {
    do {
        $added = $false
        foreach ($row in $rows) {
            $id = [int]$row.ProcessId
            $parent = $owned[[int]$row.ParentProcessId]
            if ($owned.ContainsKey($id) -or $null -eq $parent) { continue }
            $observed = $row.CreationDate.ToUniversalTime().Ticks
            # Old orphans can retain a reused parent's PID. Creation time rejects
            # those edges; all accepted parents keep their native handles open.
            if ($observed -lt ($parent.created - 9)) { continue }
            $entry = Capture-Process $row
            if ($entry.created -lt $parent.created) {
                $entry.process.Dispose()
                continue
            }
            $owned[$id] = $entry
            $added = $true
        }
    } while ($added)
}

try {
    $null = Remaining-Time
    $rows = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $rootRow = $rows | Where-Object { $_.ProcessId -eq $RootPid } | Select-Object -First 1
    if ($null -eq $rootRow -or $rootRow.ParentProcessId -ne $ParentPid) {
        throw 'Windows batch root ownership could not be established.'
    }
    $root = Capture-Process $rootRow
    $owned[$RootPid] = $root
    $startedMs = [DateTimeOffset]::new($root.process.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
    $imageMatches = if ([IO.Path]::IsPathRooted($ExpectedExecutable)) {
        [string]::Equals($root.process.MainModule.FileName, $ExpectedExecutable, [StringComparison]::OrdinalIgnoreCase)
    } else {
        [string]::Equals($root.process.MainModule.ModuleName, $ExpectedExecutable, [StringComparison]::OrdinalIgnoreCase)
    }
    if ($startedMs -lt $LaunchedAfterMs -or $startedMs -gt $LaunchedBeforeMs -or
        -not $imageMatches) {
        throw 'Windows batch root generation did not match the launch.'
    }
    try {
        Capture-Descendants $rows
        $proofAvailable = $true
    } catch {
        # A bound root still admits taskkill's existing successful-result
        # authority. Uncertain descendants cannot reconcile native failure.
        $proofAvailable = $false
    }

    $null = Remaining-Time
    [Console]::Out.WriteLine('{"ready":true}')
    [Console]::Out.Flush()
    $result = [Console]::In.ReadLine() | ConvertFrom-Json -ErrorAction Stop
    if ($result.complete -ne $true -or $null -eq $result.nativeCode) {
        throw 'Windows native cleanup did not complete.'
    }
    $nativeCode = [int]$result.nativeCode
    $null = Remaining-Time
    if ($nativeCode -eq 0) {
        [Console]::Out.WriteLine('{"complete":true,"nativeCode":0,"proof":"native"}')
        exit 0
    }
    if (-not $proofAvailable) { throw 'Windows native cleanup failed without a complete witness.' }

    foreach ($entry in $owned.Values) {
        if (-not $entry.process.WaitForExit((Remaining-Time))) {
            throw 'A captured Windows child is still running.'
        }
    }
    # As with taskkill /T, this is a bounded process snapshot, not launch-time
    # containment of arbitrary detached descendants. Rescan before accepting a
    # nonzero native result so a live child of any held generation rejects it.
    do {
        $previousCount = $owned.Count
        $rows = @(Get-CimInstance Win32_Process -ErrorAction Stop)
        Capture-Descendants $rows
        foreach ($entry in $owned.Values) {
            if (-not $entry.process.WaitForExit((Remaining-Time))) {
                throw 'A late Windows descendant is still running.'
            }
        }
        # A newly discovered generation could fork while its exit was awaited.
        # Finish with a census after every already-captured parent has exited.
    } while ($owned.Count -ne $previousCount)
    $null = Remaining-Time
    [Console]::Out.WriteLine(('{"complete":true,"nativeCode":' + $nativeCode + ',"proof":"held-handles","captured":' + $owned.Count + '}'))
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    foreach ($entry in $owned.Values) { $entry.process.Dispose() }
}
