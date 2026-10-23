import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { refreshCodexCallerCapabilityContents } from "../src/caller-key-client-refresh.mjs";
import { scanTomlDocument, tomlStringValue } from "../src/toml-structure.mjs";
import { privateFileIsProtected, writePrivateFile } from "../src/file-security.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("missing multi-agent end marker is repaired only for the exact owned feature", t => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-agent-marker-"));
  t.after(() => rmSync(testRoot, { recursive: true, force: true }));
  const codexHome = path.join(testRoot, "codex"), state = path.join(testRoot, "state");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, "caller-secret"), `${"a".repeat(48)}\n`);
  const configPath = path.join(codexHome, "config.toml");
  writeFileSync(configPath, '[features]\napps = true\n\n[desktop]\nnotifications = true\n');
  const env = { CODEX_HOME: codexHome, MODEL_ROUTER_STATE_DIR: state, CODEX_BIN: process.execPath };
  run("enable", env);
  const end = "# END codex-router-multi-agent-v2-managed";
  const emitted = readFileSync(configPath, "utf8");
  const currentFeature = emitted.split("\n").find(line => line.startsWith("multi_agent_v2 = "));
  const priorFeature = readFileSync(path.join(root, "test/fixtures/managed-multi-agent-v2-before-routing.txt"), "utf8").trim();
  for (const feature of [currentFeature, priorFeature]) {
    const damaged = emitted.replace(currentFeature, feature).replace(end, 'user_feature = true\n# user-owned note');
    writeFileSync(configPath, damaged);
    assert.equal(run("validate-enable", env).mode, "router");
    assert.equal(readFileSync(configPath, "utf8"), damaged, "preflight remains read-only");
    run("enable", env);
    const repaired = readFileSync(configPath, "utf8");
    assert.equal(repaired.split(end).length - 1, 1);
    assert.equal(managedRootHint(repaired), managedRootHint(emitted), "repair upgrades the owned hint");
    assert.match(repaired, /user_feature = true\n# user-owned note/u);
    assert.match(repaired, /apps = true/u);
    assert.match(repaired, /\[desktop\]\nnotifications = true/u);

    writeFileSync(configPath, damaged);
    assert.equal(run("disable", env).mode, "native");
    const disabled = readFileSync(configPath, "utf8");
    assert.doesNotMatch(disabled, /codex-router-multi-agent-v2-managed/u);
    assert.match(disabled, /user_feature = true\n# user-owned note/u);

    const modified = damaged.replace("max_concurrent_threads_per_session = 6", "max_concurrent_threads_per_session = 7");
    writeFileSync(configPath, modified);
    const rejected = spawnSync(process.execPath, [path.join(root, "src", "config-manager.mjs"), "enable"], {
      cwd: root, env: { ...process.env, ...env }, encoding: "utf8", windowsHide: true,
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Refusing to edit an unterminated managed block/u);
    assert.equal(readFileSync(configPath, "utf8"), modified, "a changed feature cannot authorize removal");
  }
});

function run(command, env) {
  const result = spawnSync(process.execPath, [path.join(root, "src", "config-manager.mjs"), command], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function managedRootHint(contents) {
  const document = scanTomlDocument(contents);
  const feature = document.assignments.find(({ tablePath, key }) =>
    tablePath.length === 1 && tablePath[0] === "features" &&
    key.length === 1 && key[0] === "multi_agent_v2",
  );
  assert.ok(feature, "the managed feature is a real TOML assignment");
  const rootHint = /\broot_agent_usage_hint_text\s*=\s*("(?:\\.|[^"\\])*")/u.exec(
    document.lines[feature.index],
  );
  assert.ok(rootHint, "guidance uses the native root-agent instruction field");
  return JSON.parse(rootHint[1]);
}

function configFixture(t) {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-config-boundary-"));
  t.after(() => rmSync(testRoot, { recursive: true, force: true }));
  const home = path.join(testRoot, "codex"), state = path.join(testRoot, "state");
  mkdirSync(home, { recursive: true }); mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, "caller-secret"), "a".repeat(48));
  return { config: path.join(home, "config.toml"), state,
    env: { CODEX_HOME: home, MODEL_ROUTER_STATE_DIR: state, CODEX_BIN: process.execPath } };
}

test("caller refresh updates real enabled assignments while instruction examples remain exact", t => {
  const f = configFixture(t);
  for (const quote of ['"""', "'''"]) {
    const example = [
      `developer_instructions = ${quote}`, "[model_providers.example]",
      "# BEGIN codex-router-provider-managed",
      `base_url = "http://127.0.0.1:4202/_codex-router/${"a".repeat(48)}/v1"`,
      "# END codex-router-provider-managed",
      "# BEGIN codex-router-signed-provider-managed",
      "# END codex-router-signed-provider-managed", quote, "",
    ].join("\n");
    writeFileSync(path.join(f.state, "caller-secret"), "a".repeat(48));
    writeFileSync(f.config, example);
    run("enable", f.env);
    const enabled = readFileSync(f.config, "utf8");
    const oldBase = `http://127.0.0.1:4202/_codex-router/${"a".repeat(48)}/v1`;
    const before = enabled.replaceAll('"http://127.0.0.1:4202/v1"', JSON.stringify(oldBase));
    writePrivateFile(f.config, before);
    writeFileSync(path.join(f.state, "caller-secret"), "b".repeat(48));
    run("caller-capability-refresh", f.env);
    const after = readFileSync(f.config, "utf8");
    assert.ok(after.includes(example));
    const document = scanTomlDocument(after);
    const expected = "http://127.0.0.1:4202/v1";
    assert.equal(tomlStringValue(document, [], "openai_base_url"), expected);
    assert.equal(tomlStringValue(document, ["model_providers", "codex-router"], "base_url"), expected);
    assert.equal(after, enabled, "only real legacy URL scalars migrate to the current bearer endpoint");
  }
});

test("caller refresh preserves scalar spans and refuses ambiguous real authority", () => {
  const oldBase = `http://127.0.0.1:4202/_codex-router/${"a".repeat(48)}/v1`;
  const nextBase = oldBase.replace("a".repeat(48), "b".repeat(48));
  const rootLine = `  "openai_\\u0062ase_url" = '${oldBase}' # preserve root\r\n`;
  const block = ["# BEGIN codex-router-signed-provider-managed", "[model_providers.'legacy-name']",
    `  'base_url' = "${oldBase}" # preserve signed`, "# END codex-router-signed-provider-managed", ""].join("\r\n");
  assert.equal(refreshCodexCallerCapabilityContents(rootLine + block, nextBase, { port: 4202 }),
    rootLine.replace(`'${oldBase}'`, JSON.stringify(nextBase)) + block.replace(JSON.stringify(oldBase), JSON.stringify(nextBase)));
  for (const invalid of [
    rootLine + `openai_base_url = "${oldBase}"\r\n`,
    rootLine + block.replace("model_providers.'legacy-name'", "unrelated"),
    rootLine + block.replace("# END codex-router-signed-provider-managed", ""),
    rootLine + block.replace("# END codex-router-signed-provider-managed", `base_url = "${oldBase}"\n# END codex-router-signed-provider-managed`),
    rootLine.replace(oldBase, "https://example.invalid/v1"),
    rootLine.replace(":4202/", ":9999/"),
  ]) assert.throws(() => refreshCodexCallerCapabilityContents(invalid, nextBase, { port: 4202 }));
});

for (const rollback of [false, true]) {
test(`real caller rotation and rollback refresh multiline instructions before restoring running intent (${rollback ? "rollback" : "success"})`, { timeout: 30_000 }, t => {
  const f = configFixture(t);
  const original = 'developer_instructions = """\n[documentation.example]\n# BEGIN codex-router-provider-managed\nbase_url = "http://127.0.0.1:4202/v1"\n# END codex-router-provider-managed\n"""\n';
  writeFileSync(f.config, original);
  run("enable", f.env);
  const enabled = readFileSync(f.config, "utf8");
  const code = `import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runCallerKeyRotation,runNodeCommand} from ${JSON.stringify(pathToFileURL(path.join(root, "src/caller-key.mjs")).href)};
let running=true, verifications=0; const actions=[], commands=[];
const options={assertOwnership(){},withLock:op=>op(),withMutationLocks:op=>op(),withServiceLock:op=>op(),
runNode:async(script,args)=>{assert.equal(script,'src/config-manager.mjs');commands.push(args[0]);return runNodeCommand(script,args);},
readServiceStatus:async()=>({installed:true,state:running?'running':'stopped'}),
runServiceMutation:async action=>{actions.push(action);running=action!=='stop';},
verifyServiceKeys:async()=>{verifications++;if(process.env.TEST_ROLLBACK==='1'&&verifications===1)throw new Error('synthetic verification refusal');}};
let result,error;try{result=await runCallerKeyRotation(options);}catch(e){error=e.message;}
process.stdout.write(JSON.stringify({result,error,actions,commands,verifications,running,secret:readFileSync(process.env.MODEL_ROUTER_STATE_DIR+'/caller-secret','utf8').trim()}));`;
  writePrivateFile(path.join(f.state, "caller-secret"), "a".repeat(48));
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    // Real journal transitions harden and verify each staging file. Each
    // scenario has its own 30-second test budget; leave time for fixture cleanup.
    cwd: root, encoding: "utf8", windowsHide: true, timeout: 25_000,
    env: { ...process.env, ...f.env, TEST_ROLLBACK: rollback ? "1" : "0" },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.running, true);
  assert.equal(readFileSync(f.config, "utf8"), enabled);
  assert.equal(existsSync(path.join(f.state, "caller-key-rotation.json")), false);
  if (rollback) {
    assert.match(observed.error, /synthetic verification refusal/u);
    assert.deepEqual(observed.actions, ["stop", "start", "stop", "start"]);
    assert.equal(observed.verifications, 2);
    assert.equal(observed.secret, "a".repeat(48));
    assert.deepEqual(observed.commands, ["status", "caller-capability-refresh", "caller-capability-refresh"]);
  } else {
    assert.equal(observed.result.rotated, true);
    assert.deepEqual(observed.actions, ["stop", "start"]);
    assert.equal(observed.verifications, 1);
    assert.notEqual(observed.secret, "a".repeat(48));
    assert.deepEqual(observed.commands, ["status", "caller-capability-refresh"]);
  }
});
}

test("interrupted early rollback refreshes the real client before a fresh rotation preserves unbound generations", { timeout: 30_000 }, t => {
  const f = configFixture(t), home = path.dirname(f.config);
  for (const directory of [home, f.state]) writeFileSync(path.join(directory, ".credential-fixture"), "synthetic credential fixture");
  writeFileSync(f.config, 'developer_instructions = "Synthetic recovery fixture"\n');
  writePrivateFile(path.join(f.state, "caller-secret"), "a".repeat(48));
  run("enable", f.env);
  const enabled = readFileSync(f.config, "utf8");
  const code = `import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {existsSync,readFileSync,renameSync} from 'node:fs';import path from 'node:path';
import {STATE_DIR,CALLER_SECRET_PATH,CONFIG_PATH} from ${JSON.stringify(pathToFileURL(path.join(root, "src/paths.mjs")).href)};
import {writePrivateFile,writePrivateJson} from ${JSON.stringify(pathToFileURL(path.join(root, "src/file-security.mjs")).href)};
import {runCallerKeyRotation,runNodeCommand} from ${JSON.stringify(pathToFileURL(path.join(root, "src/caller-key.mjs")).href)};
assert.equal(STATE_DIR,process.env.TEST_CREDENTIAL_STATE_ROOT);assert.equal(path.dirname(CALLER_SECRET_PATH),STATE_DIR);
const op='e'.repeat(32),prior='a'.repeat(48),unbound='u'.repeat(48),backup=CALLER_SECRET_PATH+'.rotate-rollback.'+op,displaced=CALLER_SECRET_PATH+'.rotate-displaced.'+op,temporary=CALLER_SECRET_PATH+'.rotate-new.'+op;
for(const file of [backup,displaced,temporary])assert.equal(path.dirname(file),STATE_DIR);
renameSync(CALLER_SECRET_PATH,backup);writePrivateFile(displaced,unbound);writePrivateFile(temporary,unbound);
writePrivateJson(path.join(STATE_DIR,'caller-key-rotation.json'),{version:1,phase:'prepared',operationId:op,targets:['codex'],serviceWasRunning:true,previousSecretSha256:createHash('sha256').update(prior).digest('hex')});
let running=true;const commands=[],actions=[],verified=[];
const result=await runCallerKeyRotation({assertOwnership(){},
runNode:async(script,args)=>{assert.equal(script,'src/config-manager.mjs');const output=await runNodeCommand(script,args);commands.push(args[0]);return output;},
readServiceStatus:async()=>({installed:true,state:running?'running':'stopped'}),runServiceMutation:async action=>{actions.push(action);running=action==='start';},
verifyServiceKeys:async({currentSecret})=>{assert.ok(commands.at(-1)==='caller-capability-refresh');verified.push(currentSecret===prior?'prior':'next');},
verifyCurrentKey:async({currentSecret})=>{assert.ok(currentSecret===prior);assert.equal(commands.at(-1),'caller-capability-refresh');verified.push('prior');}});
assert.ok(result.rotated);assert.ok(readFileSync(displaced,'utf8')===unbound);assert.ok(readFileSync(temporary,'utf8')===unbound);
assert.equal(existsSync(path.join(STATE_DIR,'caller-key-rotation.json')),false);assert.equal(readFileSync(CONFIG_PATH,'utf8'),${JSON.stringify(enabled)});
process.stdout.write(JSON.stringify({commands,actions,verified,running}));`;
  // The guard runs after the child environment is established and before any
  // path-dependent production imports or protected fixture mutations.
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(path.join(root, "test/fixtures/credential-state-guard.mjs")).href, "--input-type=module", "-e", code], {
    cwd: root, encoding: "utf8", windowsHide: true, timeout: 25_000,
    env: { ...process.env, ...f.env, CODEX_ROUTER_STATE_DIR: f.state,
      TEST_CREDENTIAL_STATE_ROOT: f.state, TEST_CREDENTIAL_HOME_ROOT: home },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.running, true);
  assert.deepEqual(observed.actions, ["stop", "start", "stop", "start"]);
  assert.deepEqual(observed.commands, ["caller-capability-refresh", "status", "caller-capability-refresh"]);
  assert.deepEqual(observed.verified, ["prior", "next"]);
});

test("first backup receives original bytes only after protection and failures preserve config", { timeout: 30_000 }, t => {
  const f = configFixture(t), home = path.dirname(f.config);
  const backup = `${f.config}.pre-codex-router`, observation = path.join(f.state, "backup-observation.json");
  const preload = path.join(f.state, "backup-observer.mjs");
  writeFileSync(preload, `import fs from 'node:fs'; import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {privateFileIsProtected} from ${JSON.stringify(pathToFileURL(path.join(root, "src/file-security.mjs")).href)};
const open=fs.openSync, close=fs.closeSync, write=fs.writeFileSync, exec=cp.execFileSync; let backupFd;
fs.openSync=(target,...args)=>{if(target===process.env.TEST_BACKUP&&process.env.TEST_FAULT==='exists'){write(target,'competing snapshot');throw Object.assign(new Error('synthetic EEXIST'),{code:'EEXIST'});} const fd=open(target,...args);if(target===process.env.TEST_BACKUP)backupFd=fd;return fd;};
fs.closeSync=(fd)=>{if(fd===backupFd)backupFd=undefined;return close(fd);};
fs.writeFileSync=(target,...args)=>{if(target===backupFd){const value={empty:fs.statSync(process.env.TEST_BACKUP).size===0,protected:privateFileIsProtected(process.env.TEST_BACKUP)};write(process.env.TEST_OBSERVATION,JSON.stringify(value));if(process.env.TEST_FAULT==='write')throw new Error('synthetic content failure');}return write(target,...args);};
cp.execFileSync=(file,args,options)=>{if(process.env.TEST_FAULT==='protect'&&options?.env?.CODEX_ROUTER_PRIVATE_FILES&&JSON.parse(options.env.CODEX_ROUTER_PRIVATE_FILES).includes(process.env.TEST_BACKUP))throw new Error('synthetic protection failure');return exec(file,args,options);};syncBuiltinESMExports();`);
  const original = Buffer.from('\ufeffdeveloper_instructions = "Synthetic private instruction"\r\n');
  for (const fault of ["", "protect", "write", "exists"]) {
    const caseHome = path.join(home, `case-${fault || "success"}`);
    mkdirSync(caseHome);
    const config = path.join(caseHome, "config.toml"), target = `${config}.pre-codex-router`;
    writePrivateFile(config, original);
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href,
      path.join(root, "src/config-manager.mjs"), "enable"], {
      cwd: root, encoding: "utf8", windowsHide: true, timeout: 15_000,
      env: { ...process.env, ...f.env, CODEX_HOME: caseHome,
        TEST_BACKUP: target, TEST_OBSERVATION: observation, TEST_FAULT: fault },
    });
    assert.ifError(result.error);
    if (!fault) {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(observation, "utf8")), { empty: true, protected: true });
      assert.deepEqual(readFileSync(target), original);
      assert.equal(privateFileIsProtected(target), true);
      run("enable", { ...f.env, CODEX_HOME: caseHome });
      assert.deepEqual(readFileSync(target), original, "retain the first snapshot");
    } else {
      assert.notEqual(result.status, 0);
      assert.deepEqual(readFileSync(config), original);
      if (fault === "exists") assert.equal(readFileSync(target, "utf8"), "competing snapshot");
      else assert.equal(existsSync(target), false, "remove only the invocation's failed empty/protected creation");
    }
  }
  assert.equal(existsSync(backup), false);
});

test("quoted foreign keys and mixed-spelling duplicates are refused before config mutation", t => {
  const f = configFixture(t);
  for (const original of [
    '"openai_base_url" = "https://example.invalid/v1"\n',
    String.raw`"openai_\u0062ase_url" = "https://example.invalid/v1"` + "\n",
    "'model_catalog_json' = 'C:/user/models.json'\n",
    `model_catalog_json = ${JSON.stringify(path.join(f.state, "merged-models.json"))}\n"model_catalog_json" = 'C:/user/models.json'\n`,
    '[model_providers."codex-router"]\nbase_url = "https://example.invalid/v1"\n',
  ]) {
    writeFileSync(f.config, original);
    for (const command of ["validate-enable", "enable"]) {
      const result = spawnSync(process.execPath, [path.join(root, "src/config-manager.mjs"), command], {
        env: { ...process.env, ...f.env }, encoding: "utf8", windowsHide: true,
      });
      assert.notEqual(result.status, 0, original);
      assert.equal(readFileSync(f.config, "utf8"), original);
    }
  }
});

test("managed marker and assignment examples in both multiline string types survive enable and disable", t => {
  const f = configFixture(t);
  for (const quote of ['"""', "'''"]) {
    const instructions = [
      `developer_instructions = ${quote}`,
      "# BEGIN codex-router-managed", "KEEP_ROOT", "# END codex-router-managed",
      "# BEGIN codex-router-provider-managed", "KEEP_PROVIDER", "# END codex-router-provider-managed",
      "# BEGIN codex-router-multi-agent-v2-managed", "KEEP_AGENTS", "# END codex-router-multi-agent-v2-managed",
      "[features.multi_agent_v2]", 'openai_base_url = "https://example.invalid"',
      `model_catalog_json = ${JSON.stringify(path.join(f.state, "merged-models.json"))}`,
      quote, "",
    ].join("\n");
    const userRealtime = '"experimental_realtime_ws_base_url" = "wss://example.invalid/ws#fragment"\n';
    writeFileSync(f.config, instructions + userRealtime + '"model" = "gpt-5.5"\n');
    assert.equal(run("status", f.env).managed_router_artifacts_present, false);
    assert.equal(run("enable", f.env).model, "gpt-5.5");
    const enabled = readFileSync(f.config, "utf8");
    assert.ok(enabled.includes(instructions));
    assert.ok(enabled.includes(userRealtime));
    assert.equal((enabled.match(/^experimental_realtime_ws_base_url\s*=/gmu) || []).length, 0);
    assert.match(enabled, /^multi_agent_v2 = \{ enabled = true/mu, "string example does not prevent real managed feature");
    run("enable", f.env);
    assert.equal(readFileSync(f.config, "utf8"), enabled, "second enable does not duplicate owned fields");
    run("disable", f.env);
    const disabled = readFileSync(f.config, "utf8");
    assert.ok(disabled.includes(instructions));
    assert.ok(disabled.includes(userRealtime));
    assert.equal(run("status", f.env).openai_base_url, null);
    assert.equal(run("status", f.env).managed_router_artifacts_present, false);
  }
});

test("quoted user feature configuration is preserved without a second multi-agent setting", t => {
  const f = configFixture(t);
  const original = '["features"]\n"multi_agent_v2" = { enabled = false }\n';
  writeFileSync(f.config, original); run("enable", f.env);
  const enabled = readFileSync(f.config, "utf8");
  assert.ok(enabled.includes(original));
  assert.doesNotMatch(enabled, /# BEGIN codex-router-multi-agent-v2-managed/u);
});

test("disable preserves foreign catalog assignments and restores only a known adopted source", t => {
  const f = configFixture(t);
  for (const key of ["model_catalog_json", '"model_catalog_json"']) {
    const original = `${key} = 'C:/user/models.json' # keep comment\nmodel = "gpt-5.5"\n`;
    writeFileSync(f.config, original); run("disable", f.env);
    assert.equal(readFileSync(f.config, "utf8"), original);
  }
  const sourcePath = path.join(f.state, "native-catalog-source.json");
  const original = '"model_catalog_json" = "C:/user/models.json" # keep comment\n';
  writeFileSync(f.config, original);
  writeFileSync(sourcePath, JSON.stringify({ version: 1, status: "active", path: "C:/user/models.json" }));
  if (process.platform === "win32") {
    run("disable", f.env);
    assert.equal(readFileSync(f.config, "utf8"), original);
  }
  writeFileSync(sourcePath, "{");
  const failed = spawnSync(process.execPath, [path.join(root, "src/config-manager.mjs"), "disable"], {
    env: { ...process.env, ...f.env }, encoding: "utf8", windowsHide: true,
  });
  assert.notEqual(failed.status, 0);
  assert.equal(readFileSync(f.config, "utf8"), original);
});

test("disable refuses inaccessible adoption state without changing user or managed config", t => {
  const f = configFixture(t);
  const source = path.join(f.state, "native-catalog-source.json");
  writeFileSync(source, JSON.stringify({ version: 1, status: "active", path: path.join(f.state, "native.json") }));
  writeFileSync(f.config, 'model = "gpt-5.5"\n'); run("enable", f.env);
  const before = readFileSync(f.config, "utf8");
  const preload = path.join(f.state, "deny-source.mjs");
  writeFileSync(preload, `import fs from 'node:fs'; import path from 'node:path'; import {syncBuiltinESMExports} from 'node:module';
const old=fs[process.env.DENY_METHOD];fs[process.env.DENY_METHOD]=function(p,...a){if(path.resolve(String(p))===path.resolve(process.env.DENY_SOURCE)){throw Object.assign(new Error('synthetic source denial'),{code:'EACCES'});}return old(p,...a);};syncBuiltinESMExports();`);
  for (const method of ["readFileSync", "lstatSync"]) {
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, path.join(root, "src/config-manager.mjs"), "disable"], {
      env: { ...process.env, ...f.env, DENY_METHOD: method, DENY_SOURCE: source }, encoding: "utf8", windowsHide: true,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid native catalog source state/u);
    assert.equal(readFileSync(f.config, "utf8"), before);
  }
});

test("Codex config enable and disable preserve user TOML and restore the native catalog", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-config-lite-"));
  const codexHome = path.join(testRoot, "codex");
  const state = path.join(testRoot, "state");
  const nativeCatalog = path.join(testRoot, "native-models.json");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, "caller-secret"), `${"a".repeat(48)}\n`, { mode: 0o600 });
  writeFileSync(nativeCatalog, '{"models":[]}\n');
  writeFileSync(
    path.join(state, "native-catalog-source.json"),
    `${JSON.stringify({ version: 1, path: nativeCatalog, status: "active" })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(codexHome, "config.toml"),
    `model_catalog_json = ${JSON.stringify(nativeCatalog)}\ndeveloper_instructions = "USER_POLICY"\n\n[features]\napps = true\n\n[desktop]\nnotifications = true\n`,
  );
  const env = {
    CODEX_HOME: codexHome,
    MODEL_ROUTER_STATE_DIR: state,
    CODEX_BIN: process.execPath,
  };
  try {
    const enabled = run("enable", env);
    assert.equal(enabled.mode, "router");
    const routed = readFileSync(path.join(codexHome, "config.toml"), "utf8");
    assert.match(routed, /# BEGIN codex-router-managed/u);
    assert.match(routed, /# BEGIN codex-router-provider-managed/u);
    assert.match(routed, /# BEGIN codex-router-multi-agent-v2-managed/u);
    const rootHint = managedRootHint(routed);
    assert.match(rootHint, /## Delegated-agent waiting/u);
    assert.match(rootHint, /Wait again without commentary/u);
    assert.match(rootHint, /call interrupt_agent on that child/u);
    assert.match(rootHint, /## Delegation routing/u);
    assert.match(rootHint, /Delegate only when authorized by the user, applicable AGENTS\.md, or an invoked skill/u);
    assert.match(rootHint, /may intentionally be on the critical path/u);
    assert.match(rootHint, /If the active workflow calls for a fresh child context, use fork_turns="none"/u);
    assert.match(routed, /developer_instructions = "USER_POLICY"/u);
    assert.match(routed, /\[desktop\]\nnotifications = true/u);

    writeFileSync(
      path.join(codexHome, "config.toml"),
      routed.replace("## Delegated-agent waiting", "OLD_ROUTER_HINT"),
    );
    run("enable", env);
    const refreshed = readFileSync(path.join(codexHome, "config.toml"), "utf8");
    assert.equal(managedRootHint(refreshed), rootHint, "enable refreshes the complete effective root hint");
    assert.doesNotMatch(refreshed, /OLD_ROUTER_HINT/u);
    assert.match(refreshed, /developer_instructions = "USER_POLICY"/u);

    const disabled = run("disable", env);
    assert.equal(disabled.mode, "native");
    const restored = readFileSync(path.join(codexHome, "config.toml"), "utf8");
    assert.doesNotMatch(restored, /codex-router-managed/u);
    assert.match(restored, new RegExp(`model_catalog_json = ${JSON.stringify(nativeCatalog).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u"));
    assert.match(restored, /\[features\]\napps = true/u);
    assert.match(restored, /\[desktop\]\nnotifications = true/u);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Codex config enable repairs a recognizable missing Router root end marker", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-config-repair-"));
  const codexHome = path.join(testRoot, "codex");
  const state = path.join(testRoot, "state");
  const nativeCatalog = path.join(testRoot, "native-models.json");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, "caller-secret"), `${"a".repeat(48)}\n`, { mode: 0o600 });
  writeFileSync(nativeCatalog, '{"models":[]}\n');
  writeFileSync(
    path.join(state, "native-catalog-source.json"),
    `${JSON.stringify({ version: 1, path: nativeCatalog, status: "active" })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(codexHome, "config.toml"),
    `model_catalog_json = ${JSON.stringify(nativeCatalog)}\n\n[desktop]\nnotifications = true\n`,
  );
  const env = {
    CODEX_HOME: codexHome,
    MODEL_ROUTER_STATE_DIR: state,
    CODEX_BIN: process.execPath,
  };
  try {
    run("enable", env);
    const configPath = path.join(codexHome, "config.toml");
    const damaged = readFileSync(configPath, "utf8").replace(
      "# END codex-router-managed\n",
      "",
    );
    writeFileSync(configPath, damaged);

    const validated = run("validate-enable", env);
    assert.equal(validated.mode, "router");
    assert.equal(readFileSync(configPath, "utf8"), damaged);

    const repaired = run("enable", env);
    assert.equal(repaired.mode, "router");
    const contents = readFileSync(configPath, "utf8");
    assert.equal((contents.match(/# BEGIN codex-router-managed/gu) || []).length, 1);
    assert.equal((contents.match(/# END codex-router-managed/gu) || []).length, 1);
    assert.match(contents, /\[desktop\]\nnotifications = true/u);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Codex config enable preserves a user root value after a recognizable managed prefix", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-config-refusal-"));
  const codexHome = path.join(testRoot, "codex");
  const state = path.join(testRoot, "state");
  const nativeCatalog = path.join(testRoot, "native-models.json");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, "caller-secret"), `${"a".repeat(48)}\n`, { mode: 0o600 });
  writeFileSync(nativeCatalog, '{"models":[]}\n');
  writeFileSync(
    path.join(state, "native-catalog-source.json"),
    `${JSON.stringify({ version: 1, path: nativeCatalog, status: "active" })}\n`,
    { mode: 0o600 },
  );
  const configPath = path.join(codexHome, "config.toml");
  const damaged = [
    "# BEGIN codex-router-managed",
    'openai_base_url = "http://127.0.0.1:4202/v1"',
    `model_catalog_json = ${JSON.stringify(path.join(state, "merged-models.json"))}`,
    "user_owned = true",
    "",
    "[desktop]",
    "notifications = true",
    "",
  ].join("\n");
  writeFileSync(configPath, damaged);
  const env = {
    CODEX_HOME: codexHome,
    MODEL_ROUTER_STATE_DIR: state,
    CODEX_BIN: process.execPath,
  };
  try {
    const result = run("enable", env);
    assert.equal(result.mode, "router");
    const repaired = readFileSync(configPath, "utf8");
    assert.match(repaired, /user_owned = true/u);
    assert.equal((repaired.match(/# END codex-router-managed/gu) || []).length, 1);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Codex config enable preserves user content after a recognizable managed prefix", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-config-owned-"));
  const codexHome = path.join(testRoot, "codex");
  const state = path.join(testRoot, "state");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, "caller-secret"), `${"a".repeat(48)}\n`, { mode: 0o600 });
  const configPath = path.join(codexHome, "config.toml");
  const damaged = [
    "# BEGIN codex-router-managed",
    'openai_base_url = "http://127.0.0.1:4202/v1"',
    `model_catalog_json = ${JSON.stringify(path.join(state, "merged-models.json"))}`,
    'experimental_realtime_ws_base_url = "https://example.test/v1"',
    "# user-owned note",
    "",
    "[desktop]",
    "notifications = true",
    "",
  ].join("\n");
  writeFileSync(configPath, damaged);
  const result = run("enable", {
    CODEX_HOME: codexHome,
    MODEL_ROUTER_STATE_DIR: state,
    CODEX_BIN: process.execPath,
  });
  try {
    assert.equal(result.mode, "router");
    const repaired = readFileSync(configPath, "utf8");
    assert.match(repaired, /experimental_realtime_ws_base_url = "https:\/\/example\.test\/v1"/u);
    assert.match(repaired, /# user-owned note/u);
    assert.equal((repaired.match(/# END codex-router-managed/gu) || []).length, 1);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
