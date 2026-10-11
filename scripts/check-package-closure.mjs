import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

// Read module declarations without treating comments, quoted examples, or
// regular expressions as imports. Template expressions are executable code;
// their surrounding text is not. Package source uses plain literal specifiers;
// computed imports remain an explicit entrypoint responsibility.
function tokens(source) {
  const result = [];
  let index = 0;
  function code(interpolation = false) {
    let previous, expression = true, statement = !interpolation;
    let pendingFunction, functionBody, controlHead = false, labelHead = false, caseHead;
    const braces = [], parentheses = [], ternaries = [], classHeads = [];
    const sameDepth = context => context?.[0] === braces.length && context[1] === parentheses.length;
    while (index < source.length) {
      const start = index, character = source[index];
      if (interpolation && character === "}" && braces.length === 0) { index++; return; }
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
      if (character === "`") {
        result.push({ type: "template", value: "`" });
        index++;
        let closed = false;
        while (index < source.length) {
          if (source[index] === "\\") { index += 2; continue; }
          if (source[index] === "`") { index++; closed = true; break; }
          if (source.startsWith("${", index)) {
            index += 2;
            result.push({ type: "code", value: "(" });
            code(true);
            result.push({ type: "code", value: ")" });
          } else index++;
        }
        if (!closed) throw new Error("Unterminated package source template");
        result.push({ type: "template", value: "`" });
        previous = "literal"; expression = false; statement = false; continue;
      }
      if (["'", '"'].includes(character)) {
        let escaped = false;
        index++;
        while (index < source.length && source[index] !== character) {
          if (source[index] === "\\") { escaped = true; index += 2; } else index++;
        }
        if (index >= source.length) throw new Error("Unterminated package source string");
        const value = source.slice(start + 1, index++);
        result.push({ type: "string", value, escaped });
        previous = "literal"; expression = false; statement = false; continue;
      }
      if (character === "/" && expression) {
        let inClass = false, closed = false;
        index++;
        while (index < source.length) {
          if (/[\r\n]/u.test(source[index])) break;
          if (source[index] === "\\") { index += 2; continue; }
          if (source[index] === "[") inClass = true;
          if (source[index] === "]") inClass = false;
          if (source[index++] === "/" && !inClass) { closed = true; break; }
        }
        if (!closed) throw new Error("Unterminated package source regular expression");
        while (/[a-z]/iu.test(source[index] || "")) index++;
        previous = "literal"; expression = false; statement = false; continue;
      }
      const word = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(source.slice(index));
      const value = word ? word[0] : ["=>", "++", "--", "?.", "??"].find(token => source.startsWith(token, index)) || character;
      index += value.length;
      result.push({ type: "code", value });
      // Control parentheses open a statement, unlike grouped/call expressions.
      // Likewise a statement block may be followed by a regexp statement, but
      // an object, arrow body or function expression ends an operand.
      if (value === "(") {
        parentheses.push({ control: controlHead, function: pendingFunction });
        controlHead = false;
        pendingFunction = undefined;
        expression = true; statement = false;
      } else if (value === ")") {
        const context = parentheses.pop();
        functionBody = context?.function;
        expression = context?.control === true; statement = expression;
      } else if (value === "{") {
        const classBody = sameDepth(classHeads.at(-1)?.depth) ? classHeads.at(-1) : undefined;
        const body = functionBody ?? classBody;
        const block = body !== undefined || statement || previous === "=>" || previous === ")";
        braces.push({ block, operand: body?.operand === true || previous === "=>" });
        if (classBody && !functionBody) classHeads.pop();
        functionBody = undefined;
        expression = true; statement = block;
      } else if (value === "}") {
        const context = braces.pop();
        if (!context) throw new Error("Unmatched package source brace");
        expression = context.block && !context.operand;
        statement = expression;
      } else if (value === ";") {
        expression = true; statement = true;
      } else if (value === "?") {
        ternaries.push([braces.length, parentheses.length]);
        expression = true; statement = false;
      } else if (value === ":") {
        // Reserved words used as object keys are not declaration heads.
        controlHead = false; pendingFunction = undefined;
        if (sameDepth(classHeads.at(-1)?.depth)) classHeads.pop();
        if (sameDepth(ternaries.at(-1))) { ternaries.pop(); statement = false; }
        else if (sameDepth(caseHead)) { caseHead = undefined; statement = true; }
        else statement = labelHead || previous === "default" && braces.at(-1)?.block === true;
        expression = true;
      } else if (word) {
        const keyword = ![".", "?.", "#"].includes(previous);
        controlHead = keyword && ["if", "while", "for", "with", "switch", "catch"].includes(value) || value === "await" && controlHead;
        if (value === "function" && keyword) pendingFunction = { operand: !statement };
        if (value === "class" && keyword) classHeads.push({ operand: !statement, depth: [braces.length, parentheses.length] });
        if (value === "case" && keyword) caseHead = [braces.length, parentheses.length];
        const statementKeyword = keyword && ["else", "do", "try", "finally", "catch"].includes(value);
        const declarationPrefix = keyword && statement && ["export", "default", "async"].includes(value);
        labelHead = statement && !["function", "class", "const", "let", "var", "import", "export", "default", "async"].includes(value) && !controlHead && !statementKeyword;
        expression = statementKeyword || keyword && ["return", "throw", "yield", "await", "delete", "void", "typeof", "new", "in", "instanceof", "of", "case"].includes(value);
        statement = statementKeyword || declarationPrefix;
      } else if (value === "]" || /[0-9]/u.test(value) || [".", "?."].includes(value)) {
        expression = false; statement = false;
      } else if (["++", "--"].includes(value)) {
        statement = false; // Keep prefix operand expectation; postfix stays closed.
      } else {
        expression = true; statement = false;
      }
      if (!word) labelHead = false;
      previous = value;
    }
    if (interpolation) throw new Error("Unterminated package source template expression");
  }
  code();
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
