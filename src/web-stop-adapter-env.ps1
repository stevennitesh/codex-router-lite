$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$environmentNames = @('CODEX_CLI_PATH', 'CODEX_NODE_REPL_PATH')
$failureMessage = 'Web Stop adapter environment request failed.'

function Assert-EnvironmentPair($Pair) {
    if ($null -eq $Pair -or $Pair -isnot [System.Management.Automation.PSCustomObject]) {
        throw 'Invalid environment pair.'
    }
    $properties = @($Pair.PSObject.Properties)
    if ($properties.Count -ne $environmentNames.Count) { throw 'Invalid environment pair.' }
    foreach ($name in $environmentNames) {
        if ($properties.Name -cnotcontains $name) { throw 'Invalid environment pair.' }
        if ($null -ne $Pair.$name -and $Pair.$name -isnot [string]) { throw 'Invalid environment pair.' }
    }
}

function Read-EnvironmentPair {
    $values = [ordered]@{}
    foreach ($name in $environmentNames) {
        $values[$name] = [Environment]::GetEnvironmentVariable($name, 'User')
    }
    return $values
}

function Send-EnvironmentChange {
    try {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RouterWebStopAdapterEnvironment {
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr parameter,
        string value, uint flags, uint timeout, out UIntPtr result);
}
'@
        $result = [UIntPtr]::Zero
        $sent = [RouterWebStopAdapterEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x001a,
            [UIntPtr]::Zero, 'Environment', 2, 3000, [ref]$result)
        return ($sent -ne [IntPtr]::Zero)
    } catch {
        return $false
    }
}

function Assert-SignaturePath($Path) {
    if ($Path -isnot [string] -or [string]::IsNullOrWhiteSpace($Path) -or
        $Path -match '[\x00-\x1f"<>|?*]' -or
        $Path -notmatch '^[A-Za-z]:[\\/]') {
        throw 'Invalid signature path.'
    }
    $withoutRoot = $Path.Substring(2)
    if ($withoutRoot.Contains(':') -or -not [IO.Path]::IsPathRooted($Path)) { throw 'Invalid signature path.' }
    $null = [IO.Path]::GetFullPath($Path)
}

try {
    $request = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
    if ($null -eq $request -or $request -isnot [System.Management.Automation.PSCustomObject] -or
        $request.action -isnot [string]) { throw 'Invalid environment request.' }
    switch -CaseSensitive ($request.action) {
        'readPair' {
            [ordered]@{ values = (Read-EnvironmentPair) } | ConvertTo-Json -Compress
        }
        'compareExchangePair' {
            Assert-EnvironmentPair $request.expected
            Assert-EnvironmentPair $request.values
            $before = Read-EnvironmentPair
            foreach ($name in $environmentNames) {
                if ($before[$name] -cne $request.expected.$name) {
                    $failureMessage = 'Web Stop adapter environment pair changed; no value was overwritten.'
                    throw 'Environment pair changed.'
                }
            }

            $attempted = [Collections.Generic.List[string]]::new()
            try {
                foreach ($name in $environmentNames) {
                    # Record the attempt first so a setter that fails after writing
                    # can still be restored, provided the value remains ours.
                    $attempted.Add($name)
                    [Environment]::SetEnvironmentVariable($name, $request.values.$name, 'User')
                }
                $actual = Read-EnvironmentPair
                foreach ($name in $environmentNames) {
                    if ($actual[$name] -cne $request.values.$name) { throw 'Environment pair readback failed.' }
                }
            } catch {
                $restorationFailed = $false
                for ($index = $attempted.Count - 1; $index -ge 0; $index--) {
                    $name = $attempted[$index]
                    try {
                        # Windows treats an empty string as deletion. Use that
                        # effective value only to recognize our attempted write.
                        $owned = if ($request.values.$name -ceq '') { $null } else { $request.values.$name }
                        $current = [Environment]::GetEnvironmentVariable($name, 'User')
                        if ($current -ceq $owned) {
                            [Environment]::SetEnvironmentVariable($name, $before[$name], 'User')
                            if ([Environment]::GetEnvironmentVariable($name, 'User') -cne $before[$name]) {
                                $restorationFailed = $true
                            }
                        }
                    } catch {
                        $restorationFailed = $true
                    }
                }
                $null = Send-EnvironmentChange
                $failureMessage = if ($restorationFailed) {
                    'Web Stop adapter environment update failed; restoration was incomplete.'
                } else {
                    'Web Stop adapter environment update failed; still-owned writes were restored.'
                }
                throw 'Environment pair update failed.'
            }
            [ordered]@{ values = $actual; broadcast = (Send-EnvironmentChange) } | ConvertTo-Json -Compress
        }
        'signatures' {
            $failureMessage = 'Web Stop adapter signature inspection failed.'
            if ($request.paths -isnot [Array]) { throw 'Invalid signature paths.' }
            foreach ($file in $request.paths) { Assert-SignaturePath $file }
            $items = @(foreach ($file in $request.paths) {
                $signature = Get-AuthenticodeSignature -LiteralPath $file
                @{ path = $file; status = $signature.Status.ToString();
                    signerSubject = $signature.SignerCertificate.Subject;
                    signerThumbprint = $signature.SignerCertificate.Thumbprint }
            })
            ConvertTo-Json -InputObject $items -Compress
        }
        default { throw 'Unknown environment operation.' }
    }
} catch {
    # Never print exceptions: they can include paths, environment values or input.
    [Console]::Error.WriteLine($failureMessage)
    exit 1
}
