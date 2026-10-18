$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
    $request = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
    switch ($request.action) {
        'read' {
            @{ value = [Environment]::GetEnvironmentVariable('CODEX_CLI_PATH', 'User') } | ConvertTo-Json -Compress
        }
        'compareExchange' {
            $before = [Environment]::GetEnvironmentVariable('CODEX_CLI_PATH', 'User')
            if ($before -cne $request.expected) { throw 'User CODEX_CLI_PATH changed; no value was overwritten.' }
            if ($null -ne $request.value -and $request.value -isnot [string]) { throw 'Invalid environment value.' }
            [Environment]::SetEnvironmentVariable('CODEX_CLI_PATH', $request.value, 'User')
            $actual = [Environment]::GetEnvironmentVariable('CODEX_CLI_PATH', 'User')
            if ($actual -cne $request.value) { throw 'User CODEX_CLI_PATH readback failed.' }
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RouterWebStopEnvironment {
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr parameter,
        string value, uint flags, uint timeout, out UIntPtr result);
}
'@
            $result = [UIntPtr]::Zero
            $sent = [RouterWebStopEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x001a,
                [UIntPtr]::Zero, 'Environment', 2, 3000, [ref]$result)
            @{ value = $actual; broadcast = ($sent -ne [IntPtr]::Zero) } | ConvertTo-Json -Compress
        }
        'signatures' {
            $items = @(foreach ($file in $request.paths) {
                $signature = Get-AuthenticodeSignature -LiteralPath $file
                @{ path = $file; status = $signature.Status.ToString();
                    signerSubject = $signature.SignerCertificate.Subject;
                    signerThumbprint = $signature.SignerCertificate.Thumbprint }
            })
            ConvertTo-Json -InputObject $items -Compress
        }
        default { throw 'Unknown Web Stop environment operation.' }
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
