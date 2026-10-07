import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

// Read module declarations without treating comments, quoted examples, or
// regular expressions as imports. Package source uses plain literal specifiers;
// computed imports remain an explicit entrypoint responsibility.
function tokens(source) {
  const result = [];
  let previous;
  for (let index = 0; index < source.length;) {
    const start = index, character = source[index];
    if (/\s/u.test(character)) { index++; continue; }
    if (source.startsWith("//", index)) {
      index = source.indexOf("\n", index);
      if (index < 0) break;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) throw new Error("Unterminated package source comment");
      index = end + 2; continue;
    }
    if (["'", '"', "`"].includes(character)) {
      let escaped = false;
      index++;
      while (index < source.length && source[index] !== character) {
        if (source[index] === "\\") { escaped = true; index += 2; } else index++;
      }
      if (index >= source.length) throw new Error("Unterminated package source string");
      const value = source.slice(start + 1, index++);
      result.push({ type: character === "`" ? "template" : "string", value, escaped });
      previous = "literal"; continue;
    }
    if (character === "/" && (!previous || ["(", "[", "{", "=", ":", ",", ";", "!", "?", "return", "=>"].includes(previous))) {
      let inClass = false;
      index++;
      while (index < source.length) {
        if (source[index] === "\\") { index += 2; continue; }
        if (source[index] === "[") inClass = true;
        if (source[index] === "]") inClass = false;
        if (source[index++] === "/" && !inClass) break;
      }
      while (/[a-z]/iu.test(source[index] || "")) index++;
      previous = "literal"; continue;
    }
    const word = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(source.slice(index));
    const value = word ? word[0] : source.startsWith("=>", index) ? "=>" : character;
    index += value.length;
    result.push({ type: "code", value }); previous = value;
  }
  return result;
}

export function literalModuleDependencies(source) {
  const parts = tokens(source), dependencies = [];
  const add = token => {
    if (token?.type !== "string" || !token.value.startsWith(".")) return;
    if (token.escaped) throw new Error("Relative module specifiers must use plain literal paths");
    dependencies.push(token.value);
  };
  for (let index = 0; index < parts.length; index++) {
    const token = parts[index];
    if (token.type !== "code" || !["import", "export"].includes(token.value) || parts[index - 1]?.value === ".") continue;
    if (parts[index + 1]?.value === "(") {
      if ([")", ","].includes(parts[index + 3]?.value)) add(parts[index + 2]);
      continue;
    }
    if (token.value === "import" && parts[index + 1]?.type === "string") { add(parts[index + 1]); continue; }
    if (parts[index + 1]?.value === "." || token.value === "export" && !["*", "{"].includes(parts[index + 1]?.value)) continue;
    for (let next = index + 1; next < parts.length && parts[next].value !== ";"; next++) {
      if (parts[next].type === "code" && parts[next].value === "from") { add(parts[next + 1]); break; }
    }
  }
  return [...new Set(dependencies)];
}

function packageFile(root, relative) {
  if (typeof relative !== "string" || !relative || relative.includes("\\") || path.isAbsolute(relative) ||
      relative.split("/").some(segment => !segment || segment === "." || segment === "..")) {
    throw new Error(`Unsafe package path: ${relative}`);
  }
  const target = path.resolve(root, relative), resolved = realpathSync(target);
  const inside = path.relative(root, resolved);
  if (inside.startsWith(`..${path.sep}`) || inside === ".." || path.isAbsolute(inside) || !lstatSync(target).isFile()) {
    throw new Error(`Package file escapes its source root or is not a regular file: ${relative}`);
  }
  return target;
}

export function validatePackageClosure(root, files) {
  root = realpathSync(root);
  const packaged = new Set(files), sourceFiles = new Map(files.map(file => [file, packageFile(root, file)]));
  for (const [file, target] of sourceFiles) {
    if (!file.endsWith(".mjs")) continue;
    for (const specifier of literalModuleDependencies(readFileSync(target, "utf8"))) {
      if (specifier.includes("\\") || /[?#]/u.test(specifier)) throw new Error(`Unsupported relative import in ${file}: ${specifier}`);
      const imported = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      if (!packaged.has(imported)) throw new Error(`Unpackaged local import: ${file} -> ${imported}`);
      packageFile(root, imported);
    }
  }
}
