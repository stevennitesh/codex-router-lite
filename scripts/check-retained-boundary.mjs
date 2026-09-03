import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ps1", ".sh"]);
const CHILD_PROCESS_CALL = /\b(?:execFile|execFileSync|fork|spawn|spawnSync)\s*\(/g;
const FS_DISCOVERY_CALL = /\b(?:glob|globSync|opendir|opendirSync|readdir|readdirSync)\s*\(/;

export function normalizeRepoPath(value) {
  const normalized = path.posix.normalize(String(value).replaceAll("\\", "/"));
  return normalized === "." ? "" : normalized.replace(/^\.\//, "");
}

function decodeStringLiteral(raw) {
  const quote = raw[0];
  if (!['"', "'", "`"].includes(quote) || raw.at(-1) !== quote) return undefined;
  if (quote === "`" && raw.includes("${")) return undefined;
  let value = "";
  for (let index = 1; index < raw.length - 1; index += 1) {
    const character = raw[index];
    if (character !== "\\") {
      value += character;
      continue;
    }
    index += 1;
    const escaped = raw[index];
    const escapes = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v" };
    value += escapes[escaped] ?? escaped;
  }
  return value;
}

function stringLiterals(source) {
  const values = [];
  const pattern = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/gs;
  for (const match of source.matchAll(pattern)) {
    const value = decodeStringLiteral(match[0]);
    if (value !== undefined) values.push({ raw: match[0], value, index: match.index });
  }
  return values;
}

function maskComments(source) {
  let result = "";
  let state = "code";
  let stringQuote;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (state === "line") {
      if (current === "\n") {
        state = "code";
        result += current;
      } else result += " ";
      continue;
    }
    if (state === "block") {
      if (current === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "code";
      } else result += current === "\n" ? "\n" : " ";
      continue;
    }
    if (state === "string") {
      result += current;
      if (current === "\\") {
        result += next ?? "";
        index += 1;
      } else if (current === stringQuote) state = "code";
      continue;
    }
    if (current === "/" && next === "/") {
      result += "  ";
      index += 1;
      state = "line";
    } else if (current === "/" && next === "*") {
      result += "  ";
      index += 1;
      state = "block";
    } else {
      result += current;
      if (['"', "'", "`"].includes(current)) {
        state = "string";
        stringQuote = current;
      }
    }
  }
  return result;
}

function callExpressionAt(source, openIndex) {
  let depth = 0;
  let quote;
  for (let index = openIndex; index < source.length; index += 1) {
    const current = source[index];
    if (quote) {
      if (current === "\\") index += 1;
      else if (current === quote) quote = undefined;
      continue;
    }
    if (['"', "'", "`"].includes(current)) quote = current;
    else if (current === "(") depth += 1;
    else if (current === ")" && --depth === 0) return source.slice(openIndex + 1, index);
  }
  return undefined;
}

function javascriptImports(source) {
  const clean = maskComments(source);
  const imports = [];
  const sideEffectPattern = /^\s*import\s+(["'`])([^"'`]+)\1/gm;
  const fromPattern = /^\s*(?:import|export)\s+[^;]*?\sfrom\s+(["'`])([^"'`]+)\1/gm;
  for (const pattern of [sideEffectPattern, fromPattern]) {
    for (const match of clean.matchAll(pattern)) imports.push({ specifier: match[2], kind: "static" });
  }

  const dynamicPattern = /\bimport\s*\(/g;
  for (const match of clean.matchAll(dynamicPattern)) {
    const openIndex = clean.indexOf("(", match.index);
    const expression = callExpressionAt(clean, openIndex)?.trim();
    if (expression === undefined) {
      imports.push({ kind: "nonliteral", expression: "unterminated import" });
      continue;
    }
    const literal = decodeStringLiteral(expression.replace(/,\s*$/, "").trim());
    if (literal === undefined) imports.push({ kind: "nonliteral", expression });
    else imports.push({ specifier: literal, kind: "dynamic" });
  }
  return imports;
}

function resolveRepoReference(from, reference, fileExists) {
  const clean = reference.split(/[?#]/, 1)[0];
  if (!clean.startsWith(".") && !clean.startsWith("/")) return undefined;
  const base = clean.startsWith("/") ? clean.slice(1) : path.posix.join(path.posix.dirname(from), clean);
  const candidate = normalizeRepoPath(base);
  const choices = path.posix.extname(candidate)
    ? [candidate]
    : [candidate, `${candidate}.mjs`, `${candidate}.js`, path.posix.join(candidate, "index.mjs")];
  return choices.find(fileExists) ?? candidate;
}

function repositoryScriptReferences(source, from, fileExists) {
  const references = new Set();
  const clean = maskComments(source);
  if (/node:child_process/.test(clean)) {
    for (const match of clean.matchAll(CHILD_PROCESS_CALL)) {
      const openIndex = clean.indexOf("(", match.index);
      const expression = callExpressionAt(clean, openIndex);
      if (expression === undefined) continue;
      const values = stringLiterals(expression).map(({ value }) => value);
      for (const value of values) {
        if (!SCRIPT_EXTENSIONS.has(path.posix.extname(normalizeRepoPath(value)))) continue;
        const direct = normalizeRepoPath(value.replace(/^\$PSScriptRoot[\\/]/i, ""));
        const resolved = direct.startsWith("src/") || direct.startsWith("scripts/")
          ? direct
          : resolveRepoReference(from, value, fileExists);
        if (resolved) references.add(resolved);
      }
      for (const joined of expression.matchAll(/\bpath\.join\s*\(([^)]*)\)/g)) {
        const parts = stringLiterals(joined[1]).map(({ value }) => value);
        const firstRepoPart = parts.findIndex((part) => ["src", "scripts"].includes(normalizeRepoPath(part)));
        if (firstRepoPart < 0) continue;
        const candidate = normalizeRepoPath(parts.slice(firstRepoPart).join("/"));
        if (SCRIPT_EXTENSIONS.has(path.posix.extname(candidate))) references.add(candidate);
      }
    }
  }
  for (const mapping of clean.matchAll(/\b(?:const|let)\s+\w*[Ss]cripts?\s*=\s*\{([\s\S]*?)\}\s*;/g)) {
    for (const { value } of stringLiterals(mapping[1])) {
      if (!SCRIPT_EXTENSIONS.has(path.posix.extname(normalizeRepoPath(value)))) continue;
      const candidate = normalizeRepoPath(value);
      if (fileExists(`src/${candidate}`)) references.add(`src/${candidate}`);
    }
  }
  return [...references];
}

function joinedRepoPath(argumentsSource, fileExists) {
  const parts = stringLiterals(argumentsSource).map(({ value }) => normalizeRepoPath(value));
  const firstRepoPart = parts.findIndex((part) => ["src", "scripts"].includes(part));
  if (firstRepoPart >= 0) return normalizeRepoPath(parts.slice(firstRepoPart).join("/"));
  const file = parts.at(-1);
  return file && fileExists(`src/${file}`) ? `src/${file}` : undefined;
}

function helperReturnedProcessTargets(source, fileExists) {
  const clean = maskComments(source);
  const targets = [];
  const functions = [...clean.matchAll(/\bexport\s+function\s+(\w+)\s*\([^)]*\)\s*\{([\s\S]*?)^\}/gm)];
  for (const match of functions) {
    const [, helper, body] = match;
    const cases = /\bcase\s+(["'`])([^"'`]+)\1\s*:\s*return\s+path\.join\s*\(([^)]*)\)/g;
    for (const entry of body.matchAll(cases)) {
      const target = joinedRepoPath(entry[3], fileExists);
      if (target) targets.push({ helper, selector: entry[2], target });
    }
  }
  for (const mapping of clean.matchAll(/\b(?:const|let)\s+(\w*[Ss]cripts?)\s*=\s*\{([\s\S]*?)\}\s*;/g)) {
    const [, mappingName, body] = mapping;
    const helperMatch = clean.match(new RegExp(
      `\\bexport\\s+function\\s+(\\w+)\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?return\\s+${mappingName}\\s*\\[`,
    ));
    if (!helperMatch) continue;
    for (const entry of body.matchAll(/\b([A-Za-z0-9_-]+)\s*:\s*(["'`])([^"'`]+)\2/g)) {
      const target = fileExists(`src/${normalizeRepoPath(entry[3])}`)
        ? `src/${normalizeRepoPath(entry[3])}`
        : undefined;
      if (target) targets.push({ helper: helperMatch[1], selector: entry[1], target });
    }
  }
  return targets.sort((left, right) =>
    `${left.helper}\0${left.selector}\0${left.target}`.localeCompare(`${right.helper}\0${right.selector}\0${right.target}`));
}

function maskPowerShellComments(source) {
  return source.split(/(?<=\n)/).map((line) => {
    let quote;
    for (let index = 0; index < line.length; index += 1) {
      const current = line[index];
      if (quote) {
        if (quote === '"' && current === "`") index += 1;
        else if (current === quote) quote = undefined;
      } else if (current === '"' || current === "'") quote = current;
      else if (current === "#") return `${line.slice(0, index)}${" ".repeat(line.length - index - (line.endsWith("\n") ? 1 : 0))}${line.endsWith("\n") ? "\n" : ""}`;
    }
    return line;
  }).join("");
}

function powershellReferences(source, fileExists) {
  const references = new Set();
  const clean = maskPowerShellComments(source);
  const quotedValues = [...clean.matchAll(/"(?:`.|[^"])*"|'(?:''|[^'])*'/g)]
    .map((match) => match[0].slice(1, -1).replaceAll("''", "'"));
  const bareValues = [...clean.matchAll(/\bsrc[\\/][A-Za-z0-9_.\\/-]+\.(?:c?m?js|ps1|sh)\b/g)]
    .map((match) => match[0]);
  for (const value of [...quotedValues, ...bareValues]) {
    if (!SCRIPT_EXTENSIONS.has(path.posix.extname(normalizeRepoPath(value)))) continue;
    const withoutRoot = value.replace(/^\$PSScriptRoot[\\/]/i, "");
    const candidate = normalizeRepoPath(withoutRoot.replace(/^\.\//, ""));
    if (candidate.startsWith("src/") || candidate.startsWith("scripts/") || fileExists(candidate)) {
      references.add(candidate);
    }
  }
  return [...references];
}

function explicitConfigReferences(source) {
  const references = new Set();
  for (const { value } of stringLiterals(maskComments(source))) {
    const normalized = normalizeRepoPath(value);
    const configIndex = normalized.indexOf("config/");
    if (configIndex >= 0 && normalized.endsWith(".json")) references.add(normalized.slice(configIndex));
  }
  return [...references];
}

function recursivelyDiscoversConfig(source) {
  const clean = maskComments(source);
  if (!FS_DISCOVERY_CALL.test(clean)) return false;
  return stringLiterals(clean).some(({ value }) => {
    const normalized = normalizeRepoPath(value);
    return normalized === "config" || normalized.endsWith("/config");
  }) || /\b(?:CONFIG_ROOT|configRoot|configDir)\b/.test(clean);
}

function adapterLocalTargets(source, adapterPath, fileExists) {
  const targets = new Set(javascriptImports(source)
    .filter(({ specifier }) => specifier?.startsWith("."))
    .map(({ specifier }) => resolveRepoReference(adapterPath, specifier, fileExists)));
  for (const target of repositoryScriptReferences(source, adapterPath, fileExists)) targets.add(target);
  for (const { target } of helperReturnedProcessTargets(source, fileExists)) targets.add(target);
  return [...targets].sort();
}

function validateManifest(manifest) {
  const errors = [];
  for (const key of ["retainedRoots", "retainedConfigFiles"]) {
    if (!Array.isArray(manifest[key]) || manifest[key].length === 0) errors.push(`manifest ${key} must be a nonempty array`);
  }
  for (const key of ["processScriptReferences", "powershellReferences"]) {
    if (!Array.isArray(manifest[key])) errors.push(`manifest ${key} must be an array`);
  }
  if (!manifest.excludedOwnershipGroups || typeof manifest.excludedOwnershipGroups !== "object") {
    errors.push("manifest excludedOwnershipGroups must be an object");
  }
  if (!Array.isArray(manifest.temporaryAdapters)) {
    errors.push("manifest temporaryAdapters must be an array");
  }
  if (!Array.isArray(manifest.temporaryPowerShellAdapters)) {
    errors.push("manifest temporaryPowerShellAdapters must be an array");
  }
  if (!Array.isArray(manifest.temporaryProcessAdapters)) {
    errors.push("manifest temporaryProcessAdapters must be an array");
  }
  for (const adapter of manifest.temporaryAdapters ?? []) {
    if (!adapter.path || !adapter.caller || !Array.isArray(adapter.excludedTargets) || adapter.excludedTargets.length === 0 ||
        (adapter.sharedTargets !== undefined && !Array.isArray(adapter.sharedTargets))) {
      errors.push("each temporary adapter must name path, caller, nonempty excludedTargets, and optional sharedTargets");
    }
    if (!Array.isArray(adapter.removalIssues) || adapter.removalIssues.length === 0 ||
        adapter.removalIssues.some((issue) => !Number.isInteger(issue) || issue <= 0)) {
      errors.push(`${adapter.path ?? "temporary adapter"} removalIssues must contain positive integers`);
    }
    const targets = [...(adapter.excludedTargets ?? []), ...(adapter.sharedTargets ?? [])].map(normalizeRepoPath);
    if (new Set(targets).size !== targets.length) errors.push(`${adapter.path ?? "temporary adapter"} targets must be unique`);
  }
  for (const adapter of manifest.temporaryPowerShellAdapters ?? []) {
    if (!adapter.caller || !Array.isArray(adapter.targets) || adapter.targets.length === 0) {
      errors.push("each temporary PowerShell adapter must name caller and nonempty targets");
    }
    if (!Array.isArray(adapter.removalIssues) || adapter.removalIssues.length === 0 ||
        adapter.removalIssues.some((issue) => !Number.isInteger(issue) || issue <= 0)) {
      errors.push(`${adapter.caller ?? "temporary PowerShell adapter"} removalIssues must contain positive integers`);
    }
    if (new Set((adapter.targets ?? []).map(normalizeRepoPath)).size !== (adapter.targets ?? []).length) {
      errors.push(`${adapter.caller ?? "temporary PowerShell adapter"} targets must be unique`);
    }
  }
  for (const adapter of manifest.temporaryProcessAdapters ?? []) {
    if (!adapter.caller || !adapter.adapter || !adapter.helper || !Array.isArray(adapter.targets) || adapter.targets.length === 0 ||
        adapter.targets.some((target) => !target.selector || !target.target)) {
      errors.push("each temporary process adapter must name caller, adapter, helper, and nonempty selector targets");
    }
    const targets = (adapter.targets ?? []).map(({ selector, target }) => `${selector}\0${normalizeRepoPath(target)}`);
    if (new Set(targets).size !== targets.length) {
      errors.push(`${adapter.helper ?? "temporary process adapter"} selector targets must be unique`);
    }
  }
  return errors;
}

function sameMembers(left, right) {
  return [...new Set(left)].sort().join("\n") === [...new Set(right)].sort().join("\n");
}

export function checkRetainedBoundary({ root, manifest }) {
  const repoRoot = path.resolve(root);
  const read = (repoPath) => readFileSync(path.join(repoRoot, ...normalizeRepoPath(repoPath).split("/")), "utf8");
  const fileExists = (repoPath) => {
    const normalized = normalizeRepoPath(repoPath);
    return normalized !== "" && !normalized.startsWith("../") && existsSync(path.join(repoRoot, ...normalized.split("/")));
  };
  const errors = validateManifest(manifest);
  if (errors.length > 0) return { errors, visited: [] };

  const roots = manifest.retainedRoots.map(normalizeRepoPath);
  const expectedProcessReferences = roots.filter((entry) => /\.(?:c?m?js)$/.test(entry));
  const expectedPowerShellReferences = roots.filter((entry) => entry.endsWith(".ps1"));
  if (!sameMembers(manifest.processScriptReferences.map(normalizeRepoPath), expectedProcessReferences)) {
    errors.push("manifest processScriptReferences must exactly name the retained JavaScript roots");
  }
  if (!sameMembers(manifest.powershellReferences.map(normalizeRepoPath), expectedPowerShellReferences)) {
    errors.push("manifest powershellReferences must exactly name the retained PowerShell roots");
  }
  const allowedConfigs = new Set(manifest.retainedConfigFiles.map(normalizeRepoPath));
  for (const configPath of allowedConfigs) {
    if (!configPath.startsWith("config/") || !configPath.endsWith(".json") || !fileExists(configPath)) {
      errors.push(`retained config entry must name an existing JSON file under config/: ${configPath}`);
    }
  }
  const adapters = new Map(manifest.temporaryAdapters.map((entry) => [normalizeRepoPath(entry.path), {
    ...entry,
    path: normalizeRepoPath(entry.path),
    caller: normalizeRepoPath(entry.caller),
    excludedTargets: entry.excludedTargets.map(normalizeRepoPath),
    sharedTargets: (entry.sharedTargets ?? []).map(normalizeRepoPath),
  }]));
  const reachedAdapters = new Set();
  const excludedOwners = new Map();
  for (const [group, members] of Object.entries(manifest.excludedOwnershipGroups)) {
    for (const member of members.map(normalizeRepoPath)) {
      if (excludedOwners.has(member)) errors.push(`${member} belongs to more than one excluded ownership group`);
      else excludedOwners.set(member, group);
    }
  }
  const powershellAdapterEdges = new Set();
  for (const adapter of manifest.temporaryPowerShellAdapters) {
    const caller = normalizeRepoPath(adapter.caller);
    if (!roots.includes(caller) || !caller.endsWith(".ps1")) {
      errors.push(`temporary PowerShell adapter caller must be a retained PowerShell root: ${caller}`);
    }
    const actualReferences = fileExists(caller) ? new Set(powershellReferences(read(caller), fileExists)) : new Set();
    for (const rawTarget of adapter.targets) {
      const target = normalizeRepoPath(rawTarget);
      const edge = `${caller}\0${target}`;
      if (powershellAdapterEdges.has(edge)) errors.push(`duplicate temporary PowerShell adapter edge: ${caller} -> ${target}`);
      powershellAdapterEdges.add(edge);
      if (!actualReferences.has(target)) errors.push(`temporary PowerShell adapter target is not referenced: ${caller} -> ${target}`);
      if (!excludedOwners.has(target)) errors.push(`temporary PowerShell adapter target has no excluded ownership group: ${target}`);
    }
  }

  for (const [adapterPath, adapter] of adapters) {
    if (!fileExists(adapterPath)) {
      errors.push(`temporary adapter is missing: ${adapterPath}`);
      continue;
    }
    const actual = adapterLocalTargets(read(adapterPath), adapterPath, fileExists);
    const expected = [...adapter.excludedTargets, ...adapter.sharedTargets].sort();
    if (actual.join("\n") !== expected.join("\n")) {
      errors.push(`${adapterPath} targets differ: expected [${expected.join(", ")}], found [${actual.join(", ")}]`);
    }
    for (const target of adapter.excludedTargets) {
      if (!excludedOwners.has(target)) errors.push(`${adapterPath} target ${target} has no excluded ownership group`);
    }
    for (const target of adapter.sharedTargets) {
      if (excludedOwners.has(target)) errors.push(`${adapterPath} shared target ${target} belongs to an excluded ownership group`);
    }
  }
  const declaredProcessTargets = new Map();
  for (const processAdapter of manifest.temporaryProcessAdapters) {
    const adapterPath = normalizeRepoPath(processAdapter.adapter);
    const caller = normalizeRepoPath(processAdapter.caller);
    const adapter = adapters.get(adapterPath);
    if (!adapter || adapter.caller !== caller) {
      errors.push(`temporary process adapter must follow a declared caller edge: ${caller} -> ${adapterPath}`);
      continue;
    }
    const key = `${adapterPath}\0${processAdapter.helper}`;
    if (declaredProcessTargets.has(key)) {
      errors.push(`duplicate temporary process helper declaration: ${adapterPath} -> ${processAdapter.helper}`);
      continue;
    }
    const targets = processAdapter.targets.map(({ selector, target }) => ({
      helper: processAdapter.helper,
      selector,
      target: normalizeRepoPath(target),
    })).sort((left, right) => `${left.selector}\0${left.target}`.localeCompare(`${right.selector}\0${right.target}`));
    declaredProcessTargets.set(key, targets);
    for (const { target } of targets) {
      if (!adapter.excludedTargets.includes(target)) {
        errors.push(`temporary process target is not an excluded adapter target: ${caller} -> ${adapterPath} -> ${target}`);
      }
      if (!excludedOwners.has(target)) {
        errors.push(`temporary process target has no excluded ownership group: ${target}`);
      }
    }
  }
  for (const [adapterPath] of adapters) {
    const actualByHelper = new Map();
    for (const target of helperReturnedProcessTargets(read(adapterPath), fileExists)) {
      const values = actualByHelper.get(target.helper) ?? [];
      values.push(target);
      actualByHelper.set(target.helper, values);
    }
    for (const [helper, actual] of actualByHelper) {
      const key = `${adapterPath}\0${helper}`;
      const expected = declaredProcessTargets.get(key) ?? [];
      const render = (targets) => targets.map(({ selector, target }) => `${selector}=${target}`).sort().join(", ");
      if (render(actual) !== render(expected)) {
        errors.push(`${adapterPath} process targets for ${helper} differ: expected [${render(expected)}], found [${render(actual)}]`);
      }
    }
  }

  const visited = new Set();
  const visit = (current, chain) => {
    if (visited.has(current)) return;
    visited.add(current);
    if (!fileExists(current)) {
      errors.push(`missing retained dependency: ${[...chain, current].join(" -> ")}`);
      return;
    }
    const source = read(current);
    if (current.endsWith(".mjs") || current.endsWith(".js") || current.endsWith(".cjs")) {
      for (const imported of javascriptImports(source)) {
        if (imported.kind === "nonliteral") {
          errors.push(`nonliteral dynamic import in retained closure: ${[...chain, current].join(" -> ")} imports ${imported.expression}`);
          continue;
        }
        const target = resolveRepoReference(current, imported.specifier, fileExists);
        if (!target) continue;
        examineEdge(current, target, [...chain, current]);
      }
      for (const target of repositoryScriptReferences(source, current, fileExists)) {
        examineEdge(current, target, [...chain, current]);
      }
    } else if (current.endsWith(".ps1")) {
      for (const target of powershellReferences(source, fileExists)) {
        examineEdge(current, target, [...chain, current]);
      }
    }
    for (const configPath of explicitConfigReferences(source)) {
      if (!allowedConfigs.has(configPath)) {
        errors.push(`retained config is not allowlisted: ${[...chain, current, configPath].join(" -> ")}`);
      }
    }
    if (recursivelyDiscoversConfig(source)) {
      errors.push(`recursive config discovery in retained closure: ${[...chain, current].join(" -> ")}`);
    }
  };

  const examineEdge = (caller, target, chain) => {
    if (powershellAdapterEdges.has(`${caller}\0${target}`)) return;
    const adapter = adapters.get(target);
    if (adapter) {
      if (adapter.caller !== caller) errors.push(`adapter entered by wrong caller: ${[...chain, target].join(" -> ")}`);
      else reachedAdapters.add(target);
      return;
    }
    const group = excludedOwners.get(target);
    if (group) {
      errors.push(`excluded dependency (${group}): ${[...chain, target].join(" -> ")}`);
      return;
    }
    visit(target, chain);
  };

  for (const rootPath of roots) visit(rootPath, []);
  for (const processAdapter of manifest.temporaryProcessAdapters) {
    const caller = normalizeRepoPath(processAdapter.caller);
    if (!visited.has(caller)) continue;
    const helperCall = new RegExp(`\\b${processAdapter.helper}\\s*\\(`);
    if (!helperCall.test(maskComments(read(caller)))) {
      errors.push(`temporary process helper is not used by its caller: ${caller} -> ${processAdapter.helper}`);
    }
  }
  for (const adapterPath of adapters.keys()) {
    if (!reachedAdapters.has(adapterPath)) errors.push(`temporary adapter is not reached from its exact caller: ${adapterPath}`);
  }
  return { errors: [...new Set(errors)], visited: [...visited].sort() };
}

export function loadBoundaryManifest(root, manifestPath = "maintenance/retained-boundary.json") {
  return JSON.parse(readFileSync(path.resolve(root, manifestPath), "utf8"));
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = checkRetainedBoundary({ root, manifest: loadBoundaryManifest(root) });
  if (result.errors.length > 0) {
    process.stderr.write(`retained boundary check failed (${result.errors.length})\n${result.errors.map((error) => `- ${error}`).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  console.log(`retained boundary check passed (${result.visited.length} files)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
