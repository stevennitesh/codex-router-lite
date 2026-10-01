# A WMI-created process is parented by the Windows provider, independently of
# the desktop tool's process tree. Closing the app/tool cannot kill recovery.
function Start-IndependentDeployment([string]$ScriptPath, [hashtable]$Parameters, [string]$RepoRoot) {
  . (Join-Path $PSScriptRoot "deployment-json.ps1")
  $deploymentHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
  $operationRoot = Join-Path $deploymentHome "codex-router\deployments\$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $operationRoot -Force | Out-Null
  $requestPath = Join-Path $operationRoot "request.json"
  $resultPath = Join-Path $operationRoot "result.json"
  $logPath = Join-Path $operationRoot "deployment.log"
  $Parameters["InProcess"] = $true
  foreach ($name in @($Parameters.Keys)) {
    if ($Parameters[$name] -is [Management.Automation.SwitchParameter]) { $Parameters[$name] = [bool]$Parameters[$name] }
  }
  # WMI does not inherit shell variables. Preserve the deployment policy and
  # tool search path, without copying provider credentials into the request.
  $environment = @{ PATH = $env:PATH; CODEX_HOME = $deploymentHome }
  foreach ($name in @("MODEL_ROUTER_STATE_DIR", "CODEX_ROUTER_STATE_DIR", "CODEX_ROUTER_SWITCHYARD_ROOT", "CODEX_ROUTER_SWITCHYARD_BIN", "CODEX_ROUTER_SWITCHYARD_CONFIG", "CODEX_ROUTER_SWITCHYARD_BASE_URL", "CODEX_ROUTER_OPERATION_DEADLINE_MS", "NODE_USE_ENV_PROXY")) {
    if (Test-Path -LiteralPath "Env:\$name") { $environment[$name] = [Environment]::GetEnvironmentVariable($name) }
  }
  Write-DeploymentJson $requestPath @{ script = $ScriptPath; parameters = $Parameters; environment = $environment }
  Write-DeploymentJson $resultPath @{ state = "starting" }
  New-Item -ItemType File -Path $logPath | Out-Null
  $securityModule = ([Uri](Join-Path $RepoRoot "src\file-security.mjs")).AbsoluteUri
  $protect = "const {protectPrivateFile}=await import(process.argv[1]); for(const p of process.argv.slice(2))protectPrivateFile(p);"
  & node --input-type=module -e $protect $securityModule $requestPath $resultPath $logPath
  if ($LASTEXITCODE -ne 0) { throw "Could not protect the independent deployment request and logs." }
  $worker = Join-Path $PSScriptRoot "deployment-worker.ps1"
  $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $commandLine = '"' + $powershell + '" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $worker + '" -RequestPath "' + $requestPath + '"'
  $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine; CurrentDirectory = $RepoRoot; ProcessStartupInformation = $startup }
  if ($created.ReturnValue -ne 0) { throw "Independent deployment could not start (Windows result $($created.ReturnValue)); no service was changed." }
  [pscustomobject]@{ started = $true; processId = $created.ProcessId; resultPath = $resultPath; logPath = $logPath } | ConvertTo-Json
}
