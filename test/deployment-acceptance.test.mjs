import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("independent worker reports acceptance only for a matching completed result", {skip:process.platform !== "win32"}, () => {
  const root = mkdtempSync(path.join(os.tmpdir(),"deployment-acceptance-"));
  try {
    const fixture = path.join(root,"candidate.ps1");
    writeFileSync(fixture,`param([switch]$InProcess,[string]$AcceptancePath,[string]$ExpectedRouterCommit,[string]$ExpectedBinarySha256,[string]$Case)
$ErrorActionPreference = 'Stop'
if ($Case -eq 'missing') { return }
$checks = if ($Case -eq 'empty') { @{} } else { @{ routerFullHealth = ($Case -ne 'degraded'); processIdentity = $true } }
$commit = if ($Case -eq 'different') { 'b' * 40 } else { $ExpectedRouterCommit.ToLowerInvariant() }
$value = @{ version = 1; accepted = $true; routerCommit = $commit; switchyardBinarySha256 = $ExpectedBinarySha256.ToLowerInvariant(); checks = $checks }
[IO.File]::WriteAllText($AcceptancePath, ($value | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
`);
    for (const scenario of ["valid","different","degraded","empty","missing"]) {
      const operation = path.join(root,scenario); mkdirSync(operation);
      const request = path.join(operation,"request.json");
      writeFileSync(request,JSON.stringify({script:fixture,requireAcceptance:true,environment:{},parameters:{InProcess:true,ExpectedRouterCommit:"A".repeat(40),ExpectedBinarySha256:"C".repeat(64),Case:scenario}}));
      const run = spawnSync("powershell.exe",["-NoLogo","-NoProfile","-ExecutionPolicy","Bypass","-File","maintenance/deployment-worker.ps1","-RequestPath",request],{windowsHide:true,encoding:"utf8",timeout:10000});
      const result = JSON.parse(readFileSync(path.join(operation,"result.json"),"utf8"));
      assert.equal(result.state,"completed"); assert.equal(result.succeeded,scenario === "valid",run.stderr);
      assert.equal(run.status,scenario === "valid" ? 0 : 1,run.stderr);
      if (scenario === "valid") { assert.equal(result.acceptance.routerCommit,"a".repeat(40)); assert.equal(result.acceptance.checks.processIdentity,true); }
      else assert.equal(result.acceptance,undefined);
    }
  } finally { rmSync(root,{recursive:true,force:true}); }
});
