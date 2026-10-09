import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { literalModuleDependencies, validatePackageClosure } from "../scripts/check-package-closure.mjs";

test("package closure reads static, re-export and dynamic literals without quoted examples", () => {
  const source = [
    'import "./side.mjs";',
    'import { a } from "./static.mjs";',
    'export { a as b } from "./export.mjs";',
    'export * from "./star.mjs";',
    'const pending = import("./dynamic.mjs");',
    'import "node:fs";',
    '// import "./comment.mjs";',
    '/* export * from "./comment2.mjs"; */',
    "const example = 'import \"./example.mjs\"';",
    'const template = `import "./template.mjs"`;',
    'const expression = /import(".fake")/;',
    'const computed = import("./" + name);',
    'const meta = import.meta.url;',
  ].join("\n");
  assert.deepEqual(literalModuleDependencies(source), ["./side.mjs", "./static.mjs", "./export.mjs", "./star.mjs", "./dynamic.mjs"]);
});

test("package closure rejects omitted dependencies, missing files and unsafe paths", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "router-package-closure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src/main.mjs"), 'import { helper } from "./helper.mjs";');
  writeFileSync(path.join(root, "src/helper.mjs"), "export const helper = 42;");
  assert.throws(() => validatePackageClosure(root, ["src/main.mjs"]), /Unpackaged local import: src\/main.mjs -> src\/helper.mjs/u);
  assert.doesNotThrow(() => validatePackageClosure(root, ["src/main.mjs", "src/helper.mjs"]));
  assert.throws(() => validatePackageClosure(root, ["src/main.mjs", "src/absent.mjs"]), /ENOENT/u);
  for (const file of ["../outside.mjs", path.resolve(root, "src/main.mjs"), "src/../src/main.mjs", "src\\main.mjs"]) {
    assert.throws(() => validatePackageClosure(root, [file]), /Unsafe package path/u);
  }
  writeFileSync(path.join(root, "src/main.mjs"), 'export * from "../../outside.mjs";');
  assert.throws(() => validatePackageClosure(root, ["src/main.mjs", "src/helper.mjs"]), /Unpackaged local import/u);
});

test("package closure follows executable nested templates and ignores inert template text", t => {
  const source = [
    'console.log(`value: ${(await import("./required.mjs")).value}`);',
    'const nested = `${({ value: `${(await import("./nested.mjs")).value}` }).value}`;',
    'const inert = `import "./inert.mjs" \\${import("./escaped.mjs")}`;',
    'const ignored = `${"}" + /[}]/.source + `literal backtick: \\`` /* } */}`;',
    'const braces = `${(() => { const x = { value: "}" }; return x.value; })()}`;',
  ].join("\n");
  assert.deepEqual(literalModuleDependencies(source), ["./required.mjs", "./nested.mjs"]);
  const root = mkdtempSync(path.join(os.tmpdir(), "router-package-template-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "main.mjs"), source);
  for (const name of ["required", "nested"]) writeFileSync(path.join(root, `${name}.mjs`), 'export const value = 42;');
  assert.throws(() => validatePackageClosure(root, ["main.mjs"]), /Unpackaged local import.*required\.mjs/u);
  validatePackageClosure(root, ["main.mjs", "required.mjs", "nested.mjs"]);
  const loaded = spawnSync(process.execPath, [path.join(root, "main.mjs")], { encoding: "utf8", windowsHide: true });
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.match(loaded.stdout, /value: 42/u);
  assert.throws(() => literalModuleDependencies('const x = `${import("./\\u0061.mjs")}`;'), /plain literal paths/u);
  assert.throws(() => literalModuleDependencies('const x = `${({a:1})'), /Unterminated package source template expression/u);
});
