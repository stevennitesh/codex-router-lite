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

test("statement regexps and expression division retain independent import closure", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "router-package-regexp-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const regexp = '/import(".fake.mjs")|export .* from ".fake.mjs"/';
  const cases = [
    `const r = ${regexp};`, `if (false) ${regexp}.test("safe");`,
    `while (false) ${regexp}.test("safe");`, `for (;false;) ${regexp}.test("safe");`,
    `if (true) {} else ${regexp}.test("safe");`, `if (false) {} ${regexp}.test("safe");`,
    `try {} catch {} ${regexp}.test("safe");`,
    `if ((false)) { if (true) {} ${regexp}.test("safe"); }`,
    `label: {} ${regexp}.test("safe");`,
    `switch (0) { case (true ? 0 : 1): {} ${regexp}.test("safe"); break; default: {} ${regexp}.test("safe"); }`,
    `for await (const value of []) ${regexp}.test("safe");`,
    `const object = { class: 8 }; {} ${regexp}.test("safe");`,
    `const r = \`value: \${(() => { if (false) {} return ${regexp}.source; })()}\`;`,
    'const n = (8) / import("./required.mjs");',
    'const n = ({ value: 8 }).value / import("./required.mjs");',
    'const n = (() => {}) / import("./required.mjs");',
    'const n = function() {} / import("./required.mjs");',
    'const n = class {} / import("./required.mjs");',
    'const n = class extends (function() {}) {} / import("./required.mjs");',
    'const n = class extends Object({}).constructor {} / import("./required.mjs");',
    'const n = ({ if() { return 8; } }).if() / import("./required.mjs");',
    'const n = ({ return: 8 }).return / import("./required.mjs");',
    'const n = ({ value: 8 }) / import("./required.mjs");',
    'let n = 8; n++ / import("./required.mjs");',
  ];
  for (const [index, source] of cases.entries()) {
    const file = path.join(root, "main.mjs");
    writeFileSync(file, source);
    const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8", windowsHide: true });
    assert.equal(syntax.status, 0, syntax.stderr);
    const expected = source.includes('import("./required.mjs")') ? ["./required.mjs"] : [];
    assert.deepEqual(literalModuleDependencies(source), expected, `case ${index}: ${source}`);
    if (expected.length) assert.throws(() => validatePackageClosure(root, ["main.mjs"]), /Unpackaged local import/u);
    else validatePackageClosure(root, ["main.mjs"]);
  }
  writeFileSync(path.join(root, "required.mjs"), 'process.stdout.write("actual-import-ran"); export const value = 2;');
  writeFileSync(path.join(root, "main.mjs"), 'const n = (8) / import("./required.mjs");');
  validatePackageClosure(root, ["main.mjs", "required.mjs"]);
  const executed = spawnSync(process.execPath, [path.join(root, "main.mjs")], { encoding: "utf8", windowsHide: true });
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(executed.stdout, "actual-import-ran");
  assert.throws(() => literalModuleDependencies('if (true) /unterminated'), /Unterminated package source regular expression/u);
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
