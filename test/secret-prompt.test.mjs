import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const canary = "synthetic-private-prompt-canary";
function child(source, options = {}) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", windowsHide: true, timeout: 15_000,
    env: { ...process.env, FIXTURE_CAPTURED_KEY: canary, ...options.env },
  });
}

test("provider-key CLI suppresses actual failed child output and preserves stored state", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "secret-prompt-failure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const key = path.join(root, "openrouter-api-key.secret");
  writeFileSync(key, "unchanged synthetic key");
  const result = child(`
    import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
    const exec=cp.execFileSync;
    cp.execFileSync=(_command,_args,options)=>exec(process.execPath,['-e',"process.stdout.write(process.env.FIXTURE_CAPTURED_KEY);process.stderr.write(process.env.FIXTURE_CAPTURED_KEY);process.exit(27)"],options);
    syncBuiltinESMExports();
    process.argv=[process.execPath,'src/provider-key.mjs','openrouter','set'];
    await import('./src/provider-key.mjs');
  `, { env: { MODEL_ROUTER_STATE_DIR: root, CODEX_HOME: root } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /hidden key input failed \(exit 27\)/);
  assert.equal((result.stdout + result.stderr).includes(canary), false);
  assert.equal(readFileSync(key, "utf8"), "unchanged synthetic key");
  assert.equal(existsSync(path.join(root, "enabled-providers.json")), false);
});

test("captured-output overflow returns a credential-free error without retrying the prompt", () => {
  const result = child(`
    import assert from 'node:assert/strict'; import cp from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module'; import {inspect} from 'node:util';
    const exec=cp.execFileSync; let attempts=0;
    cp.execFileSync=(_command,_args,options)=>{attempts++;return exec(process.execPath,['-e','process.stdout.write(process.env.FIXTURE_CAPTURED_KEY.repeat(1000))'],{...options,maxBuffer:64});};
    syncBuiltinESMExports();
    const {promptForSecret}=await import('./src/secret-prompt.mjs');
    let failure;
    try{promptForSecret('Fixture key');}catch(error){failure=error;}
    assert.equal(attempts,1);
    assert.equal(failure.code,'secret_prompt_failed');
    assert.equal(inspect(failure).includes(process.env.FIXTURE_CAPTURED_KEY),false);
    assert.equal(failure.cause,undefined);
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.stdout + result.stderr).includes(canary), false);
});

test("missing PowerShell falls back; successful capture and doubled-input confirmation stay usable", () => {
  const result = child(`
    import assert from 'node:assert/strict'; import cp from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    let attempts=0;
    cp.execFileSync=(command)=>{attempts++;if(command==='powershell.exe'){const e=new Error('synthetic startup');e.code='ENOENT';throw e;}return process.env.FIXTURE_CAPTURED_KEY;};
    syncBuiltinESMExports();
    const {promptForSecret}=await import('./src/secret-prompt.mjs');
    assert.equal(promptForSecret('Fixture key'),process.env.FIXTURE_CAPTURED_KEY);
    assert.equal(attempts,2);
    let step=0;
    const inputs=[process.env.FIXTURE_CAPTURED_KEY.repeat(2),'no',process.env.FIXTURE_CAPTURED_KEY];
    cp.execFileSync=()=>inputs[step++];
    syncBuiltinESMExports();
    assert.equal(promptForSecret('Fixture key'),process.env.FIXTURE_CAPTURED_KEY);
    assert.equal(step,3);
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.stdout + result.stderr).includes(canary), false);
});

test("confirmation failure also discards captured child diagnostics", () => {
  const result = child(`
    import assert from 'node:assert/strict'; import cp from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module'; import {inspect} from 'node:util';
    let calls=0;
    cp.execFileSync=()=>{if(++calls===1)return process.env.FIXTURE_CAPTURED_KEY.repeat(2);const e=new Error('synthetic failure');e.stdout=process.env.FIXTURE_CAPTURED_KEY;e.stderr=e.stdout;e.output=[null,e.stdout,e.stderr];throw e;};
    syncBuiltinESMExports();
    const {promptForSecret}=await import('./src/secret-prompt.mjs');
    assert.throws(()=>promptForSecret('Fixture key'),error=>error.code==='secret_prompt_failed'&&!inspect(error).includes(process.env.FIXTURE_CAPTURED_KEY));
    assert.equal(calls,2);
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.stdout + result.stderr).includes(canary), false);
});
