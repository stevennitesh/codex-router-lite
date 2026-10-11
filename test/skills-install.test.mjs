import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const checkout = path.resolve(import.meta.dirname, "..");
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "router-skills-install-"));
  t.after(() => rmSync(root, {recursive:true,force:true}));
  const source = path.join(root,"source"), home = path.join(root,"home"), state = path.join(root,"state");
  cpSync(path.join(checkout,"skills"),source,{recursive:true});
  const names = readdirSync(source).sort();
  const preload = path.join(root,"faults.mjs");
  writeFileSync(preload, String.raw`
import fs from 'node:fs';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import childProcess from 'node:child_process';
const original = {cp:fs.cpSync,rename:fs.renameSync,mkdtemp:fs.mkdtempSync,write:fs.writeFileSync};
const fault = process.env.SKILL_TEST_FAULT, target = process.env.SKILL_TEST_TARGET;
const counts = {copies:0,publications:0,staging:0,retirements:0};
fs.cpSync = (from,to,options) => {
  counts.copies++;
  if(options?.errorOnExist) {
    counts.publications++;
    if(fault?.startsWith('fail-copy')) throw Object.assign(new Error('Synthetic publication failure'),{code:'EIO'});
  }
  return original.cp(from,to,options);
};
fs.mkdtempSync = (prefix,...args) => {
  if(path.basename(prefix).startsWith('.codex-router-install-')) counts.staging++;
  if(path.basename(prefix).startsWith('.codex-router-retire-')) counts.retirements++;
  return original.mkdtemp(prefix,...args);
};
fs.renameSync = (from,to) => {
  if(path.basename(from).startsWith('.codex-router-metadata-')) {
    if(fault === 'fail-metadata') throw Object.assign(new Error('Synthetic metadata failure'),{code:'EIO'});
  }
  const isContent = path.basename(to)==='content' && path.basename(path.dirname(to)).startsWith('.codex-router-retire-');
  if(from === target && isContent) {
    const result = original.rename(from,to);
    if(fault === 'crash-retirement') process.kill(process.pid,'SIGKILL');
    if(fault === 'changed-retired-marker') {
      const marker = path.join(to,'.codex-router-managed');
      const value = JSON.parse(fs.readFileSync(marker,'utf8'));
      value.token = '0'.repeat(64); original.write(marker,JSON.stringify(value));
    }
    return result;
  }
  return original.rename(from,to);
};
childProcess.execFileSync = ((exec) => (file,args,options) => {
  const to = options?.env?.CODEX_ROUTER_RECOVERY_TARGET;
  if(to === target && fault?.startsWith('fail-copy-race-')) {
    if(fault.endsWith('file')) original.write(to,'Competing user file');
    else {
      fs.mkdirSync(to);
      if(fault.endsWith('populated')) original.write(path.join(to,'user.txt'),'Competing user content');
    }
  }
  return exec(file,args,options);
})(childProcess.execFileSync);
// Replace the marker during staging, before the production ownership recheck.
fs.closeSync = ((close) => (descriptor) => {
  const result = close(descriptor);
  if(fault === 'changed-metadata-marker' && fs.readdirSync(path.dirname(target)).some(n=>n.startsWith('.codex-router-metadata-'))) {
    const marker = path.join(target,'.codex-router-managed');
    const value = JSON.parse(fs.readFileSync(marker,'utf8'));
    value.token = '0'.repeat(64); original.write(marker,JSON.stringify(value));
  }
  return result;
})(fs.closeSync);
syncBuiltinESMExports();
process.on('exit',()=>original.write(process.env.SKILL_TEST_COUNTS,JSON.stringify(counts)));
`);
  let sequence = 0;
  const invoke = (args, {fault="", expectSuccess=true}={}) => {
    const counters = path.join(root,`counts-${++sequence}.json`);
    const result = spawnSync(process.execPath,["--import",pathToFileURL(preload).href,"src/skills-install.mjs",...args],{
      cwd:checkout,encoding:"utf8",windowsHide:true,
      timeout:30_000,
      env:{...process.env,CODEX_HOME:home,CODEX_ROUTER_SKILLS_DIR:source,MODEL_ROUTER_STATE_DIR:state,CODEX_ROUTER_STATE_DIR:state,
        SKILL_TEST_FAULT:fault,SKILL_TEST_TARGET:path.join(home,"skills",names[0]),SKILL_TEST_COUNTS:counters},
    });
    assert.ifError(result.error);
    if(expectSuccess) assert.equal(result.status,0,result.stderr);
    return {...result,counts:existsSync(counters)?JSON.parse(readFileSync(counters,"utf8")):undefined};
  };
  const run = (...args) => invoke(args).stderr;
  return {source,home,state,names,run,invoke,skills:path.join(home,"skills"),ownership:path.join(state,"managed-skills.json")};
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

test("changed content replaces owned skills and stale skills still retire", t => {
  const f = fixture(t); f.run("install");
  const name = f.names[0], sourceFile = path.join(f.source,name,"SKILL.md"), installedFile = path.join(f.skills,name,"SKILL.md");
  const markerPath = path.join(f.skills,name,".codex-router-managed");
  const originalMarker = JSON.parse(readFileSync(markerPath,"utf8"));
  const changed = readFileSync(sourceFile,"utf8") + "\nSynthetic fixture content update.\n";
  writeFileSync(sourceFile,changed);
  assert.match(f.run("install"),/installed 1 skill/u);
  assert.equal(readFileSync(installedFile,"utf8"),changed);
  assert.equal(JSON.parse(readFileSync(markerPath,"utf8")).token,originalMarker.token);
  rmSync(path.join(f.source,name),{recursive:true,force:true});
  assert.match(f.run("install"),/removed stale managed skill/u);
  assert.equal(existsSync(path.join(f.skills,name)),false);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(f.ownership,"utf8")).skills,name),false);
});

test("provenance-only refresh preserves instruction and ownership bytes without copying or retiring", t => {
  const f = fixture(t); f.run("install");
  const name = f.names[0], dir = path.join(f.skills,name), markerPath = path.join(dir,".codex-router-managed");
  const original = JSON.parse(readFileSync(markerPath,"utf8"));
  writeFileSync(markerPath,JSON.stringify({...original,source:{packageVersion:"old-version",commit:"old-commit"}}));
  oldTimes(path.join(dir,"SKILL.md")); oldTimes(f.ownership);
  const before = {instructions:snapshot(path.join(dir,"SKILL.md")),ownership:snapshot(f.ownership)};
  const result = f.invoke(["install"]);
  assert.match(result.stderr,/installed 0 skill.*refreshed metadata for 1/u);
  assert.deepEqual(result.counts,{copies:0,publications:0,staging:0,retirements:0});
  assert.deepEqual(JSON.parse(readFileSync(markerPath,"utf8")),original);
  assert.deepEqual({instructions:snapshot(path.join(dir,"SKILL.md")),ownership:snapshot(f.ownership)},before);
  assert.deepEqual(readdirSync(f.skills).sort(),f.names);
});

test("failed metadata refresh leaves the old marker and skill usable", t => {
  const f = fixture(t); f.run("install");
  const dir = path.join(f.skills,f.names[0]), markerPath = path.join(dir,".codex-router-managed");
  const marker = JSON.parse(readFileSync(markerPath,"utf8")); marker.source.commit = "prior-commit";
  writeFileSync(markerPath,JSON.stringify(marker));
  const before = {instructions:snapshot(path.join(dir,"SKILL.md")),marker:readFileSync(markerPath,"utf8"),ownership:snapshot(f.ownership)};
  const result = f.invoke(["install"],{fault:"fail-metadata",expectSuccess:false});
  assert.equal(result.status,2); assert.match(result.stderr,/Synthetic metadata failure/u);
  assert.deepEqual(result.counts,{copies:0,publications:0,staging:0,retirements:0});
  assert.deepEqual({instructions:snapshot(path.join(dir,"SKILL.md")),marker:readFileSync(markerPath,"utf8"),ownership:snapshot(f.ownership)},before);
  assert.deepEqual(readdirSync(f.skills).sort(),f.names);
  assert.match(f.run("install"),/refreshed metadata for 1/u);
});

test("metadata refresh refuses a marker changed during staging", t => {
  const f = fixture(t); f.run("install");
  const dir = path.join(f.skills,f.names[0]), markerPath = path.join(dir,".codex-router-managed");
  const marker = JSON.parse(readFileSync(markerPath,"utf8")); marker.source.commit = "prior-commit";
  writeFileSync(markerPath,JSON.stringify(marker));
  const before = readFileSync(path.join(dir,"SKILL.md"),"utf8");
  const result = f.invoke(["install"],{fault:"changed-metadata-marker",expectSuccess:false});
  assert.equal(result.status,2); assert.match(result.stderr,/changed while refreshing metadata/u);
  assert.equal(JSON.parse(readFileSync(markerPath,"utf8")).token,"0".repeat(64));
  assert.equal(readFileSync(path.join(dir,"SKILL.md"),"utf8"),before);
  assert.deepEqual(readdirSync(f.skills).sort(),f.names);
  assert.match(f.run("install"),/skipped 1/u);
});

test("failed skill publication restores the exact previous Windows path and ownership", {skip:process.platform!=="win32"}, t => {
  const f = fixture(t); f.run("install");
  const name = f.names[0], dir = path.join(f.skills,name), sourceFile = path.join(f.source,name,"SKILL.md");
  const before = {skill:snapshot(dir),ownership:snapshot(f.ownership)};
  writeFileSync(sourceFile,readFileSync(sourceFile,"utf8")+"\nChanged fixture instructions.\n");
  const result = f.invoke(["install"],{fault:"fail-copy",expectSuccess:false});
  assert.equal(result.status,2); assert.match(result.stderr,/Synthetic publication failure/u);
  assert.deepEqual({skill:snapshot(dir),ownership:snapshot(f.ownership)},before);
  assert.deepEqual(readdirSync(f.skills).sort(),f.names);
  assert.match(f.run("install"),/installed 1 skill/u);
  assert.equal(readFileSync(path.join(dir,"SKILL.md"),"utf8"),readFileSync(sourceFile,"utf8"));
});

for(const kind of ["empty","populated","file"]) {
  test(`Windows recovery preserves a competing ${kind} path appearing at rename`, {skip:process.platform!=="win32"}, t => {
    const f = fixture(t); f.run("install");
    const name = f.names[0], sourceFile = path.join(f.source,name,"SKILL.md"), dir = path.join(f.skills,name);
    const previous = readFileSync(path.join(dir,"SKILL.md"),"utf8");
    writeFileSync(sourceFile,previous+"\nChanged fixture instructions.\n");
    const result = f.invoke(["install"],{fault:`fail-copy-race-${kind}`,expectSuccess:false});
    assert.equal(result.status,2); assert.match(result.stderr,/Synthetic publication failure/u);
    if(kind === "file") assert.equal(readFileSync(dir,"utf8"),"Competing user file");
    else assert.deepEqual(readdirSync(dir),kind === "empty"?[]:["user.txt"]);
    if(kind === "populated") assert.equal(readFileSync(path.join(dir,"user.txt"),"utf8"),"Competing user content");
    const preserved = readdirSync(f.skills).filter(n=>n.startsWith(`${name}.codex-router-preserved-`));
    assert.equal(preserved.length,1);
    assert.equal(readFileSync(path.join(f.skills,preserved[0],"SKILL.md"),"utf8"),previous);
  });
}

test("Windows recovery restores an abandoned retirement after actual process termination", {skip:process.platform!=="win32"}, t => {
  const f = fixture(t); f.run("install");
  const name = f.names[0], sourceFile = path.join(f.source,name,"SKILL.md"), dir = path.join(f.skills,name);
  const previous = readFileSync(sourceFile,"utf8");
  writeFileSync(sourceFile,previous+"\nChanged fixture instructions.\n");
  const result = f.invoke(["install"],{fault:"crash-retirement",expectSuccess:false});
  assert.notEqual(result.status,0); assert.equal(existsSync(dir),false);
  assert.equal(readdirSync(f.skills).filter(n=>n.startsWith(".codex-router-retire-")).length,1);
  writeFileSync(sourceFile,previous);
  assert.match(f.run("install"),/installed 0 skill/u);
  assert.equal(readFileSync(path.join(dir,"SKILL.md"),"utf8"),previous);
  // A terminated process may retain its unverified prepublication staging.
  // Recovery may consume the journaled retirement, never guess-delete staging.
  assert.deepEqual(readdirSync(f.skills).filter(n=>!n.startsWith('.codex-router-install-')).sort(),f.names);
});

test("changed ownership after retirement is preserved rather than published or removed", {skip:process.platform!=="win32"}, t => {
  const f = fixture(t); f.run("install");
  const name = f.names[0], sourceFile = path.join(f.source,name,"SKILL.md"), dir = path.join(f.skills,name);
  const previous = readFileSync(sourceFile,"utf8"); writeFileSync(sourceFile,previous+"\nChanged fixture instructions.\n");
  const result = f.invoke(["install"],{fault:"changed-retired-marker"});
  assert.match(result.stderr,/installed 0 skill.*skipped 1/u);
  assert.equal(readFileSync(path.join(dir,"SKILL.md"),"utf8"),previous);
  assert.equal(JSON.parse(readFileSync(path.join(dir,".codex-router-managed"),"utf8")).token,"0".repeat(64));
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(f.ownership,"utf8")).skills,name),false);
  assert.deepEqual(readdirSync(f.skills).sort(),f.names);
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
