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
    writeFileSync(fixture,`param([switch]$InProcess,[string]$AcceptancePath,[string]$ExpectedRouterCommit,[string]$ExpectedBinarySha256,[string]$Case,[string]$Label)
$ErrorActionPreference = 'Stop'
if ($Case -eq 'missing') { return }
$checks = if ($Case -eq 'empty') { @{} } else { @{ routerFullHealth = ($Case -ne 'degraded'); processIdentity = $true } }
$commit = if ($Case -eq 'different') { 'b' * 40 } else { $ExpectedRouterCommit.ToLowerInvariant() }
$value = @{ version = 1; accepted = $true; routerCommit = $commit; switchyardBinarySha256 = $ExpectedBinarySha256.ToLowerInvariant(); checks = $checks; label = $Label; environment = $env:DEPLOY_TEST_LABEL; message = ('caf' + [char]0x00e9) }
[IO.File]::WriteAllText($AcceptancePath, ($value | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
if ($Case -eq 'script-exit') { exit 17 }
if ($Case -eq 'native-exit') { & $env:NODE_TEST_BINARY -e 'process.exit(19)' }
`);
    const unicodeFixture = path.join(root,"candidate-\u00e9.ps1");
    writeFileSync(unicodeFixture, readFileSync(fixture));
    for (const scenario of ["valid","unicode","different","degraded","empty","missing","script-exit","native-exit"]) {
      const operation = path.join(root,scenario); mkdirSync(operation);
      const request = path.join(operation,"request.json");
      const valid = scenario === "valid" || scenario === "unicode";
      writeFileSync(request,JSON.stringify({script:scenario === "unicode" ? unicodeFixture : fixture,requireAcceptance:true,environment:{DEPLOY_TEST_LABEL:"caf\u00e9"},parameters:{InProcess:true,ExpectedRouterCommit:"A".repeat(40),ExpectedBinarySha256:"C".repeat(64),Case:scenario,Label:"caf\u00e9"}}),"utf8");
      const run = spawnSync("powershell.exe",["-NoLogo","-NoProfile","-ExecutionPolicy","Bypass","-File","maintenance/deployment-worker.ps1","-RequestPath",request],{windowsHide:true,encoding:"utf8",timeout:10000,env:{...process.env,NODE_TEST_BINARY:process.execPath}});
      const result = JSON.parse(readFileSync(path.join(operation,"result.json"),"utf8"));
      assert.equal(result.state,"completed"); assert.equal(result.succeeded,valid,`${scenario}: ${run.stderr}`);
      assert.equal(run.status,valid ? 0 : 1,`${scenario}: ${run.stderr}`);
      if (valid) {
        assert.equal(result.acceptance.routerCommit,"a".repeat(40)); assert.equal(result.acceptance.checks.processIdentity,true);
        assert.equal(result.acceptance.label,"caf\u00e9");
        assert.equal(result.acceptance.environment,"caf\u00e9");
        assert.equal(result.acceptance.message,"caf\u00e9");
      }
      else assert.equal(result.acceptance,undefined);
      if (scenario === "script-exit") assert.match(result.error,/exited with status 17/u);
      if (scenario === "native-exit") assert.match(result.error,/exited with status 19/u);
    }
  } finally { rmSync(root,{recursive:true,force:true}); }
});
