import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const checkout = path.resolve(import.meta.dirname, "..");
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "router-skills-install-"));
  t.after(() => rmSync(root, {recursive:true,force:true}));
  const source = path.join(root,"source"), home = path.join(root,"home"), state = path.join(root,"state");
  cpSync(path.join(checkout,"skills"),source,{recursive:true});
  const names = readdirSync(source).sort();
  const run = (...args) => {
    const result = spawnSync(process.execPath,["src/skills-install.mjs",...args],{
      cwd:checkout,encoding:"utf8",windowsHide:true,
      env:{...process.env,CODEX_HOME:home,CODEX_ROUTER_SKILLS_DIR:source,MODEL_ROUTER_STATE_DIR:state,CODEX_ROUTER_STATE_DIR:state},
    });
    assert.equal(result.status,0,result.stderr);
    return result.stderr;
  };
  return {source,home,state,names,run,skills:path.join(home,"skills"),ownership:path.join(state,"managed-skills.json")};
}

function snapshot(root) {
  const records = [];
  function walk(target, relative = "") {
    const stat = statSync(target);
    records.push([relative,stat.mtimeMs,stat.size,stat.isFile()
      ? createHash("sha256").update(readFileSync(target)).digest("hex") : null]);
    if (stat.isDirectory()) for (const name of readdirSync(target).sort()) walk(path.join(target,name),path.join(relative,name));
  }
  walk(root);
  return records;
}

function oldTimes(target) {
  if (statSync(target).isDirectory()) for (const name of readdirSync(target)) oldTimes(path.join(target,name));
  const when = new Date("2001-01-01T00:00:00.000Z");
  utimesSync(target,when,when);
}

test("identical owned skills preserve files, markers and durable ownership without publication", t => {
  const f = fixture(t);
  assert.match(f.run("install"),new RegExp(`installed ${f.names.length} skill`));
  oldTimes(f.skills); oldTimes(f.ownership);
  const before = {skills:snapshot(f.skills),ownership:snapshot(f.ownership)};
  assert.match(f.run("install"),new RegExp(`installed 0 skill.*unchanged ${f.names.length}`));
  assert.deepEqual({skills:snapshot(f.skills),ownership:snapshot(f.ownership)},before);
  assert.deepEqual(readdirSync(f.skills).sort(),f.names);
});

test("changed content and provenance still replace owned skills and stale skills still retire", t => {
  const f = fixture(t); f.run("install");
  const name = f.names[0], sourceFile = path.join(f.source,name,"SKILL.md"), installedFile = path.join(f.skills,name,"SKILL.md");
  const markerPath = path.join(f.skills,name,".codex-router-managed");
  const originalMarker = JSON.parse(readFileSync(markerPath,"utf8"));
  const changed = readFileSync(sourceFile,"utf8") + "\nSynthetic fixture content update.\n";
  writeFileSync(sourceFile,changed);
  assert.match(f.run("install"),/installed 1 skill/u);
  assert.equal(readFileSync(installedFile,"utf8"),changed);
  assert.equal(JSON.parse(readFileSync(markerPath,"utf8")).token,originalMarker.token);
  const priorProvenance = {...originalMarker,source:{...originalMarker.source,commit:"synthetic-prior-commit"}};
  writeFileSync(markerPath,JSON.stringify(priorProvenance));
  assert.match(f.run("install"),/installed 1 skill/u);
  const refreshed = JSON.parse(readFileSync(markerPath,"utf8"));
  assert.deepEqual(refreshed.source,originalMarker.source);
  assert.equal(refreshed.token,originalMarker.token);
  rmSync(path.join(f.source,name),{recursive:true,force:true});
  assert.match(f.run("install"),/removed stale managed skill/u);
  assert.equal(existsSync(path.join(f.skills,name)),false);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(f.ownership,"utf8")).skills,name),false);
});

test("content equality never adopts unowned or mismatched-token skills; exact external approvals survive", t => {
  const f = fixture(t), name = f.names[0], external = path.join(f.skills,name);
  mkdirSync(f.skills,{recursive:true});
  cpSync(path.join(f.source,name),external,{recursive:true});
  oldTimes(external); const before = snapshot(external);
  assert.match(f.run("install"),/skipped 1/u);
  assert.deepEqual(snapshot(external),before);
  assert.equal(existsSync(path.join(external,".codex-router-managed")),false);
  f.run("approve-external",name);
  oldTimes(f.ownership); const approval = snapshot(f.ownership);
  assert.match(f.run("install"),/using 1 approved external/u);
  assert.deepEqual(snapshot(external),before);
  assert.deepEqual(snapshot(f.ownership),approval);
  const ownedName = f.names[1], markerPath = path.join(f.skills,ownedName,".codex-router-managed");
  const marker = JSON.parse(readFileSync(markerPath,"utf8"));
  marker.token = "0".repeat(64); writeFileSync(markerPath,JSON.stringify(marker));
  const mismatch = snapshot(path.join(f.skills,ownedName));
  assert.match(f.run("install"),/skipped 1/u);
  assert.deepEqual(snapshot(path.join(f.skills,ownedName)),mismatch);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(f.ownership,"utf8")).skills,ownedName),false);
});
