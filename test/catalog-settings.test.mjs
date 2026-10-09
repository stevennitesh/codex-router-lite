import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { LISTED_MODELS } from "../src/routed-models.mjs";

const repo = path.resolve(import.meta.dirname, "..");
const slugs = LISTED_MODELS.filter(m => m.provider === "openrouter").map(m => m.slug);
const windows = { skip: process.platform !== "win32" };
function json(target, value) { writeFileSync(target, JSON.stringify(value) + "\n"); }
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "router-catalog-settings-"));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith("router-catalog-settings-"));
    rmSync(root, { recursive: true, force: true });
  });
  const home = path.join(root, "codex"), state = path.join(root, "state"), agents = path.join(home, "agents");
  mkdirSync(home); mkdirSync(state);
  const picker = path.join(state, "model-picker.json"), multi = path.join(state, "multi-agent-settings.json"), providers = path.join(state, "enabled-providers.json");
  const native = { slug: "gpt-5.5", visibility: "list", display_name: "Fixture", priority: 1,
    base_instructions: "You are Codex, an agent based on GPT-5.6-Sol.",
    model_messages: { instructions_template: "You are Codex, an agent based on GPT-5.6-Sol." },
    input_modalities: ["text", "image"], context_window: 300000, max_context_window: 900000,
    effective_context_window_percent: 95, shell_type: "unified_exec", multi_agent_version: "v2" };
  const models = [native, { ...native, slug: "gpt-5.6-sol", priority: 2 }];
  const source = path.join(root, "source.json"); json(source, { models });
  json(path.join(state, "native-catalog-source.json"), { version: 1, status: "active", path: source });
  json(providers, { version: 1, providers: ["openrouter"] });
  json(picker, { version: 1, hidden: [], visible: slugs, seeded: slugs });
  json(multi, { version: 2, mode: "proven", enabled: [], disabled: [] });
  writeFileSync(path.join(home, "config.toml"), 'model = "gpt-5.5"\n');
  const binary = path.join(root, "codex.cmd");
  writeFileSync(binary, '@node "%~dp0fake-codex.mjs" %*\r\n');
  writeFileSync(path.join(root, "fake-codex.mjs"),
    `const a=process.argv.slice(2).join(' '); if(a==='--version')console.log('codex-cli 0.153.0'); else if(a==='login status')console.log('Logged in'); else if(a==='debug models --bundled')console.log(${JSON.stringify(JSON.stringify({ models }))}); else process.exitCode=2;\n`);
  const preload = path.join(root, "failure.mjs");
  writeFileSync(preload, [
    "import fs from 'node:fs'; import path from 'node:path'; import {syncBuiltinESMExports} from 'node:module';",
    "const match=(p,key)=>process.env[key] && path.resolve(String(p))===path.resolve(process.env[key]);",
    "for(const [method,key] of [['readFileSync','DENY_READ'],['lstatSync','DENY_PROBE'],['unlinkSync','DENY_DELETE'],['readdirSync','DENY_ENUMERATE']]){const original=fs[method];fs[method]=function(p,...args){if(match(p,key)){const e=new Error('private-error-canary');e.code='EACCES';throw e;}return original(p,...args);};}",
    "const rename=fs.renameSync;fs.renameSync=function(a,b){if(match(b,'DENY_RESTORE')){const e=new Error('synthetic restore failure');e.code='EACCES';throw e;}return rename(a,b);};",
    "syncBuiltinESMExports();",
  ].join("\n"));
  const env = { ...process.env, CODEX_HOME: home, CODEX_BIN: binary, CODEX_ROUTER_SOURCE_ROOT: repo,
    CODEX_ROUTER_STATE_DIR: state, MODEL_ROUTER_STATE_DIR: state,
    MODEL_ROUTER_MODEL_PICKER_STATE: picker, MODEL_ROUTER_MULTI_AGENT_STATE: multi };
  delete env.MODEL_ROUTER_SIGNED_ROUTING; delete env.MODEL_ROUTER_TEST_FAIL_AFTER_CATALOG_WRITE;
  return { root, home, state, agents, picker, multi, providers, env, preload };
}
function args(file, commands, preload) {
  return [...(preload ? ["--import", pathToFileURL(preload).href] : []), path.join(repo, "src", file), ...commands];
}
function run(f, file, commands, extra = {}, preload) {
  const result = spawnSync(process.execPath, args(file, commands, preload), {
    cwd: repo, env: { ...f.env, ...extra }, encoding: "utf8", windowsHide: true, timeout: 45000,
  });
  assert.equal(result.error, undefined);
  return result;
}
function success(result) { assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); }
function publish(f, extra, preload) { return run(f, "catalog.mjs", ["--refresh-if-stale"], extra, preload); }
function outputSnapshot(f) {
  return Object.fromEntries([path.join(f.state, "merged-models.json"), path.join(f.state, "announced-models.json"),
    ...readdirSync(f.agents).map(file => path.join(f.agents, file))].map(file => [file, readFileSync(file, "utf8")]));
}

for (const [kind, field, statusArgs] of [["provider", "providers", ["providers", "status"]], ["picker", "picker", ["picker", "status"]], ["subagent", "multi", ["subagents", "status"]]]) {
  test(`ordinary publication preserves all output when ${kind} settings are invalid or unreadable`, windows, t => {
    const f = fixture(t);
    if (kind === "provider") json(f.providers, { version: 1, providers: [] });
    if (kind === "subagent") json(f.multi, { version: 2, mode: "selected", enabled: [slugs[0]], disabled: [], efforts: { [slugs[0]]: "high" } });
    success(publish(f));
    const target = f[field], original = readFileSync(target, "utf8"), before = outputSnapshot(f);
    const originalPicker = readFileSync(f.picker, "utf8");
    for (const failure of ["json", "version", "read", "probe"]) {
      const malformed = failure === "json" ? '{"private-error-canary":' : JSON.stringify({ ...JSON.parse(original), version: 9876 });
      if (failure === "json" || failure === "version") writeFileSync(target, malformed);
      else writeFileSync(target, original);
      const input = readFileSync(target, "utf8");
      const extra = failure === "read" ? { DENY_READ: target } : failure === "probe" ? { DENY_PROBE: target } : {};
      const denied = publish(f, extra, f.preload);
      assert.notEqual(denied.status, 0, failure);
      assert.match(denied.stderr, /Cannot read/u);
      assert.ok(!denied.stderr.includes("private-error-canary"));
      assert.equal(readFileSync(target, "utf8"), input);
      assert.deepEqual(outputSnapshot(f), before);
      if (kind !== "picker") assert.equal(readFileSync(f.picker, "utf8"), originalPicker);
      assert.equal(existsSync(path.join(f.state, "catalog-publication.lock")), false, "failure releases lock");
      const diagnostic = success(run(f, "control.mjs", statusArgs, extra, f.preload));
      assert.ok(diagnostic.degraded || diagnostic.snapshot?.degraded);
    }
    writeFileSync(target, original);
    assert.equal(success(publish(f)).changed, false);
  });
}

test("operator changes reject invalid settings while supported legacy picker and provider data remain usable", windows, t => {
  const f = fixture(t);
  for (const [file, command] of [[f.picker, ["picker", "show", slugs[0]]], [f.multi, ["subagents", "off", slugs[0]]]]) {
    const original = readFileSync(file, "utf8");
    writeFileSync(file, "{");
    assert.notEqual(run(f, "control.mjs", command).status, 0);
    assert.equal(readFileSync(file, "utf8"), "{");
    writeFileSync(file, original);
  }
  json(f.picker, { version: 1, hidden: [slugs[1]], seeded: slugs });
  const legacy = success(run(f, "control.mjs", ["picker", "status"]));
  assert.ok(legacy.visible.includes(slugs[0])); assert.ok(!legacy.visible.includes(slugs[1]));
  success(publish(f));
  const next = success(run(f, "control.mjs", ["picker", "show", slugs[1]]));
  assert.ok(next.visible.includes(slugs[1]));
  json(f.providers, { version: 1, providers: ["openrouter", "retired-provider"] });
  const migrated = success(run(f, "control.mjs", ["providers", "status"]));
  assert.deepEqual(migrated.providers, ["openrouter"]); assert.deepEqual(migrated.ignored, ["retired-provider"]);
  writeFileSync(f.providers, "{");
  assert.notEqual(run(f, "provider-selection.mjs", ["ensure-configured"]).status, 0);
  assert.equal(readFileSync(f.providers, "utf8"), "{");
  assert.deepEqual(success(run(f, "control.mjs", ["providers", "set", "openrouter"])).providers, ["openrouter"], "explicit full set can repair its selection");
});

test("failed required role removal rolls back the catalog and earlier role deletions, then retry converges", windows, t => {
  const f = fixture(t); success(publish(f));
  const before = outputSnapshot(f), names = readdirSync(f.agents).sort();
  assert.equal(names.length, slugs.length);
  const off = names.slice(0, 2);
  for (const name of off) {
    const slug = /^model = "([^"]+)"/mu.exec(readFileSync(path.join(f.agents, name), "utf8"))[1];
    success(run(f, "control.mjs", ["subagents", "off", slug]));
  }
  writeFileSync(path.join(f.agents, "user-worker.toml"), "USER_OWNED\n");
  const withUser = outputSnapshot(f);
  const failed = publish(f, { DENY_DELETE: path.join(f.agents, off[1]) }, f.preload);
  assert.equal(failed.status, 75, failed.stderr);
  assert.match(failed.stderr, /Could not remove managed routed agent/u);
  assert.deepEqual(outputSnapshot(f), withUser, "both prior managed files and prior catalog are restored");
  success(publish(f));
  assert.ok(off.every(name => !existsSync(path.join(f.agents, name))));
  assert.equal(readFileSync(path.join(f.agents, "user-worker.toml"), "utf8"), "USER_OWNED\n");
  assert.equal(Object.keys(before).length, slugs.length + 2);
});

test("unreadable agent enumeration and failed agent restoration cannot claim a complete publication", windows, t => {
  const f = fixture(t); success(publish(f));
  const before = outputSnapshot(f), names = readdirSync(f.agents).sort();
  const enumeration = publish(f, { DENY_ENUMERATE: f.agents }, f.preload);
  assert.equal(enumeration.status, 75, enumeration.stderr);
  assert.match(enumeration.stderr, /Could not enumerate managed routed agents/u);
  assert.deepEqual(outputSnapshot(f), before);
  for (const name of names.slice(0, 2)) {
    const slug = /^model = "([^"]+)"/mu.exec(readFileSync(path.join(f.agents, name), "utf8"))[1];
    success(run(f, "control.mjs", ["subagents", "off", slug]));
  }
  const failed = publish(f, { DENY_DELETE: path.join(f.agents, names[1]), DENY_RESTORE: path.join(f.agents, names[0]) }, f.preload);
  assert.equal(failed.status, 1, "incomplete role restoration is not rollback-safe exit 75");
  assert.match(failed.stderr, /previous files could not be restored/u);
  assert.equal(readFileSync(path.join(f.state, "merged-models.json"), "utf8"), before[path.join(f.state, "merged-models.json")]);
  success(publish(f));
  assert.ok(names.slice(0, 2).every(name => !existsSync(path.join(f.agents, name))));
});

async function launch(f, file, commands, extra = {}, preload) {
  const child = spawn(process.execPath, args(file, commands, preload), { cwd: repo, env: { ...f.env, ...extra }, windowsHide: true });
  let stdout = "", stderr = "";
  child.stdout.on("data", b => stdout += b); child.stderr.on("data", b => stderr += b);
  const complete = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", status => resolve({ status, stdout, stderr })); });
  return { child, complete };
}
async function until(predicate, description) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 10000) throw new Error(description);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test("ordinary picker show waits for overlapping watcher seeding and disjoint choices survive", windows, async t => {
  const f = fixture(t);
  json(f.picker, { version: 1, hidden: [], visible: slugs.slice(1), seeded: slugs.slice(1) });
  const ready = path.join(f.root, "ready"), release = path.join(f.root, "release"), waiting = path.join(f.root, "waiting");
  const pause = path.join(f.root, "pause.mjs");
  writeFileSync(pause, `import fs from 'node:fs'; import path from 'node:path'; import {syncBuiltinESMExports} from 'node:module'; const rename=fs.renameSync;
fs.renameSync=function(a,b){if(path.resolve(String(b))===path.resolve(process.env.PAUSE_PICKER)){fs.writeFileSync(process.env.READY,'ready');const start=Date.now();while(!fs.existsSync(process.env.RELEASE)){if(Date.now()-start>15000)throw new Error('barrier timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}}return rename(a,b);};syncBuiltinESMExports();`);
  const observer = path.join(f.root, "observer.mjs");
  // Detect an actual attempted acquisition in proper-lockfile's callback API.
  writeFileSync(observer, `import fs from 'node:fs'; const original=fs.mkdir;
fs.mkdir=function(p,...rest){if(String(p)===process.env.LOCK_PATH)fs.writeFileSync(process.env.WAITING,'waiting');return original.call(this,p,...rest);};`);
  const publisher = await launch(f, "catalog.mjs", ["--refresh-if-stale"], { PAUSE_PICKER: f.picker, READY: ready, RELEASE: release }, pause);
  let operator;
  try {
    await until(() => existsSync(ready), "publisher did not reach seed commit");
    operator = await launch(f, "control.mjs", ["picker", "show", slugs[0]], { WAITING: waiting, LOCK_PATH: path.join(f.state, "catalog-publication.lock") }, observer);
    await until(() => existsSync(waiting), "operator did not reach the held publication lock");
    assert.equal(operator.child.exitCode, null);
    assert.ok(!JSON.parse(readFileSync(f.picker, "utf8")).visible.includes(slugs[0]));
    writeFileSync(release, "go");
    success(await publisher.complete); success(await operator.complete);
    assert.ok(JSON.parse(readFileSync(f.picker, "utf8")).visible.includes(slugs[0]));
    success(publish(f));
    assert.ok(JSON.parse(readFileSync(f.picker, "utf8")).visible.includes(slugs[0]));
    const first = await launch(f, "control.mjs", ["picker", "hide", slugs[0]]);
    const second = await launch(f, "control.mjs", ["picker", "hide", slugs[1]]);
    success(await first.complete); success(await second.complete);
    const final = JSON.parse(readFileSync(f.picker, "utf8"));
    assert.ok(final.hidden.includes(slugs[0]) && final.hidden.includes(slugs[1]));
  } finally {
    if (!existsSync(release)) writeFileSync(release, "go");
    await publisher.complete;
    if (operator) await operator.complete;
  }
});
