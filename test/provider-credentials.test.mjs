import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("credential atomic replacement protects a previously permissive target", t => {
  const root = mkdtempSync(path.join(os.tmpdir(),"router-credential-write-"));
  t.after(() => rmSync(root,{recursive:true,force:true}));
  const source = `
    import assert from 'node:assert/strict';
    import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
    import path from 'node:path';
    import {writeProviderCredential,primaryCredentialPath} from './src/provider-credentials.mjs';
    import {privateFileIsProtected} from './src/file-security.mjs';
    const target = primaryCredentialPath();
    mkdirSync(path.dirname(target),{recursive:true});
    writeFileSync(target,'synthetic old fixture value');
    assert.equal(privateFileIsProtected(target),false);
    assert.equal(writeProviderCredential('openrouter','synthetic fixture credential'),target);
    assert.equal(readFileSync(target,'utf8'),'synthetic fixture credential\\n');
    assert.equal(privateFileIsProtected(target),true);
  `;
  const result = spawnSync(process.execPath,["--input-type=module","-e",source],{
    cwd:path.resolve(import.meta.dirname,".."),encoding:"utf8",windowsHide:true,
    env:{...process.env,MODEL_ROUTER_STATE_DIR:root,CODEX_ROUTER_STATE_DIR:root,CODEX_HOME:root},
  });
  assert.equal(result.status,0,result.stderr);
});
