$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

# WMI creates the actual launcher under the Windows provider, outside the
# requesting Codex/tool process tree. EnvironmentVariables replaces inherited
# state: only Windows essentials and the three isolated bridge paths are sent.
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$executable = [string]$request.executable
if (-not [IO.Path]::IsPathRooted($executable) -or [IO.Path]::GetExtension($executable) -ine '.exe' -or -not (Test-Path -LiteralPath $executable -PathType Leaf)) {
  throw 'The Web launcher must be an existing absolute .exe path.'
}
$environment = [string[]]@($request.environment.PSObject.Properties | ForEach-Object { $_.Name + '=' + [string]$_.Value })
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{
  ShowWindow = [uint16]0
  EnvironmentVariables = $environment
}
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = '"' + $executable + '"'
  CurrentDirectory = [IO.Path]::GetDirectoryName($executable)
  ProcessStartupInformation = $startup
}
if ($created.ReturnValue -ne 0) { throw "Independent Web launcher could not start (Windows result $($created.ReturnValue))." }
[Console]::Out.Write((@{ processId = [int]$created.ProcessId } | ConvertTo-Json -Compress))
