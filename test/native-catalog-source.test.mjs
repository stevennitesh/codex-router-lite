import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {scanTomlDocument} from "../src/toml-structure.mjs";

const script = path.resolve(import.meta.dirname, "..", "src", "native-catalog-source.mjs");

test("native adoption reads real root assignments and retains legacy Windows path decoding", {skip:process.platform !== "win32"}, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-adoption-"));
  const home = path.join(root, "home"), state = path.join(root, "state");
  const actual = path.join(root, "models.json"), fake = path.join(root, "fake.json");
  mkdirSync(home); mkdirSync(state);
  writeFileSync(actual, JSON.stringify({models:[{slug:"gpt-native"}]}));
  writeFileSync(fake, JSON.stringify({models:[{slug:"gpt-fake"}]}));
  const statePath = path.join(state, "native-catalog-source.json");
  const run = contents => {
    writeFileSync(path.join(home, "config.toml"), contents);
    return spawnSync(process.execPath, [script, "prepare-from-config"], {encoding:"utf8",windowsHide:true,
      env:{...process.env,CODEX_HOME:home,MODEL_ROUTER_STATE_DIR:state}});
  };
  const prelude = ['developer_instructions = """', `model_catalog_json = '${fake}'`,
    'openai_base_url = "https://instruction-lookalike.test"', '[not_a_real_table]', '"""', ""].join("\n");
  try {
    for (const assignment of [
      `"model_catalog_json" = '${actual}'`,
      `'model_catalog_json' = "${actual}"`,
      `model_catalog_json = ${JSON.stringify(actual)}`,
      `model_catalog_json = "\\U${actual.codePointAt(0).toString(16).padStart(8,"0")}${JSON.stringify(actual).slice(2,-1)}"`,
    ]) {
      if (existsSync(statePath)) rmSync(statePath);
      const result = run(prelude + assignment + "\n");
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(readFileSync(statePath,"utf8")).path, actual);
    }
    rmSync(statePath);
    const duplicate = run(prelude + `model_catalog_json = '${actual}'\n"model_catalog_json" = '${fake}'\n`);
    assert.notEqual(duplicate.status, 0);
    assert.equal(existsSync(statePath), false);
    const transport = run(prelude + `model_catalog_json = '${actual}'\n"openai_base_url" = "https://actual-override.test"\n`);
    assert.notEqual(transport.status, 0);
    assert.equal(existsSync(statePath), false);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("the TOML structural owner's default decoder still rejects invalid escapes", () => {
  assert.throws(() => scanTomlDocument('model_catalog_json = "C:\\Users\\synthetic\\models.json"\n'), /basic string escape is invalid/u);
});
