import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readInstallManifestDetail } from "../src/install-manifest.mjs";

test("manifest detail distinguishes absent, invalid and unavailable records without retaining payloads", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "manifest-detail-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, "manifest.json");
  assert.equal(readInstallManifestDetail({ manifestPath }).status, "missing");
  for (const content of ["{broken", '{"version":2}', "null"]) {
    writeFileSync(manifestPath, content);
    assert.deepEqual(readInstallManifestDetail({ manifestPath }), { status: "invalid" });
  }
  writeFileSync(manifestPath, '{"version":1,"current":{}}');
  assert.equal(readInstallManifestDetail({ manifestPath }).status, "present");
  for (const [code, expected] of [["EPERM", "access-denied"], ["EIO", "probe-failed"], ["ENOENT", "probe-failed"]]) {
    const fail = () => { const error = new Error("synthetic-sensitive-detail"); error.code = code; throw error; };
    assert.deepEqual(readInstallManifestDetail({ manifestPath, readFile: fail }), { status: expected, code });
    assert.deepEqual(readInstallManifestDetail({ manifestPath, lstat: fail }), { status: code === "ENOENT" ? "missing" : expected, code });
  }
});

test("ordinary config writes preserve state on indeterminate or foreign ownership", { skip: process.platform !== "win32" }, t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "owner-guard-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = `
    import assert from 'node:assert/strict';
    import {writeFileSync,readFileSync,rmSync} from 'node:fs';
    import path from 'node:path';
    import {readInstallManifest,readInstallManifestDetail} from './src/install-manifest.mjs';
    import {writeLiteLlmConfig} from './src/litellm-config.mjs';
    import {INSTALL_MANIFEST_PATH,LITELLM_CONFIG_PATH,SOURCE_ROOT} from './src/paths.mjs';
    const cases=[
      ['missing',null,null],
      ['same',JSON.stringify({version:1,current:{sourceRoot:SOURCE_ROOT}}),null],
      ['ownerless',JSON.stringify({version:1,current:{}}),null],
      ['foreign',JSON.stringify({version:1,current:{sourceRoot:path.join(process.env.MODEL_ROUTER_STATE_DIR,'other-checkout')}}),'foreign_state_owner'],
      ['malformed','{broken','indeterminate_state_owner'],
      ['version',JSON.stringify({version:2,current:{sourceRoot:SOURCE_ROOT}}),'indeterminate_state_owner'],
      ['relative',JSON.stringify({version:1,current:{sourceRoot:'relative'}}),'indeterminate_state_owner'],
      ['invalid-owner',JSON.stringify({version:1,current:{sourceRoot:['array']}}),'indeterminate_state_owner'],
    ];
    for(const [name,content,expected] of cases){
      rmSync(INSTALL_MANIFEST_PATH,{force:true});
      if(content!==null)writeFileSync(INSTALL_MANIFEST_PATH,content);
      writeFileSync(LITELLM_CONFIG_PATH,'unchanged synthetic config');
      if(expected){
        assert.throws(()=>writeLiteLlmConfig(),e=>e.code===expected,name);
        assert.equal(readFileSync(LITELLM_CONFIG_PATH,'utf8'),'unchanged synthetic config',name);
      }else{
        writeLiteLlmConfig();
        assert.match(readFileSync(LITELLM_CONFIG_PATH,'utf8'),/model_list:/,name);
      }
    }
    writeFileSync(INSTALL_MANIFEST_PATH,'{broken');
    assert.equal(readInstallManifest(),undefined,'tolerant wrapper still supports diagnostics');
    assert.equal(readInstallManifestDetail().status,'invalid');
    process.env.MODEL_ROUTER_ALLOW_FOREIGN_STATE='1';
    writeLiteLlmConfig();
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", windowsHide: true, timeout: 30_000,
    env: { ...process.env, MODEL_ROUTER_STATE_DIR: root, CODEX_HOME: root, MODEL_ROUTER_ALLOW_FOREIGN_STATE: "0" },
  });
  assert.equal(result.status, 0, result.stderr);
});

test("a real unreadable manifest cannot authorize a guarded write", { skip: process.platform !== "win32" }, t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "owner-unreadable-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = path.join(root, "install-manifest.json"), target = path.join(root, "litellm.yaml");
  writeFileSync(manifest, '{"version":1,"current":{}}');
  writeFileSync(target, "unchanged synthetic config");
  const script = "$ErrorActionPreference='Stop'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[IO.File]::GetAccessControl($env:FIXTURE_FILE); $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::ReadData,[Security.AccessControl.AccessControlType]::Deny)); [IO.File]::SetAccessControl($env:FIXTURE_FILE,$acl)";
  execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    windowsHide: true, timeout: 15_000, env: { ...process.env, FIXTURE_FILE: manifest },
  });
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import {readInstallManifest,readInstallManifestDetail} from './src/install-manifest.mjs';
    import {writeLiteLlmConfig} from './src/litellm-config.mjs';
    assert.equal(readInstallManifestDetail().status,'access-denied');
    assert.equal(readInstallManifest(),undefined);
    assert.throws(()=>writeLiteLlmConfig(),e=>e.code==='indeterminate_state_owner');
  `], {
    cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", windowsHide: true, timeout: 15_000,
    env: { ...process.env, MODEL_ROUTER_STATE_DIR: root, CODEX_HOME: root, MODEL_ROUTER_ALLOW_FOREIGN_STATE: "0" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(target, "utf8"), "unchanged synthetic config");
});
