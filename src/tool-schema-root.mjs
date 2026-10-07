// Provider-facing tool parameters use an object root when the declaration
// supplies object evidence. Keep union constraints intact: merging branches
// would lose legal modes, branch requirements, and differing property shapes.

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_DEPTH = 8;

// Resolves only local URI-fragment JSON Pointers: `#` and `#/...`. RFC 6901
// fragment decoding happens before `~1` / `~0` token decoding. Object own keys
// and canonical in-range array indexes are traversable; malformed fragments,
// anchors such as `#node`, and unsupported targets remain unresolved. The
// eligibility check deliberately does not infer semantics for `$dynamicRef` or
// `$recursiveRef` -- only an actual `$ref` crosses this boundary.
function resolveRef(ref, root) {
  if (typeof ref !== "string" || !ref.startsWith("#")) return undefined;
  let pointer;
  try {
    pointer = decodeURIComponent(ref.slice(1));
  } catch {
    return undefined;
  }
  if (pointer === "") return isPlainObject(root) ? root : undefined;
  if (!pointer.startsWith("/")) return undefined;

  let node = root;
  for (const rawSegment of pointer.slice(1).split("/")) {
    if (/~(?:[^01]|$)/.test(rawSegment)) return undefined;
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(node)) {
      if (!/^(?:0|[1-9]\d*)$/.test(segment)) return undefined;
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= node.length || !(index in node)) {
        return undefined;
      }
      node = node[index];
      continue;
    }
    if (!isPlainObject(node) || !Object.hasOwn(node, segment)) return undefined;
    node = node[segment];
  }
  return isPlainObject(node) ? node : undefined;
}

// Collect object evidence from a bounded root union. References are inspected
// only for eligibility; the provider schema retains their original spelling.
function objectBranches(schema, root, seen, depth = 0) {
  if (!isPlainObject(schema) || depth > MAX_DEPTH) return [];
  const types = declaredTypes(schema);
  if (schema.type !== undefined && !types.includes("object")) return [];
  if (types.includes("object") || (schema.type === undefined && isPlainObject(schema.properties))) {
    return [schema];
  }
  if (typeof schema.$ref === "string") {
    if (seen.has(schema.$ref)) return [];
    seen.add(schema.$ref);
    return objectBranches(resolveRef(schema.$ref, root), root, seen, depth + 1);
  }
  const branches = [];
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    if (!Array.isArray(schema[keyword])) continue;
    for (const branch of schema[keyword]) {
      branches.push(...objectBranches(branch, root, seen, depth + 1));
    }
  }
  return branches;
}

const UNION_KEYWORDS = ["anyOf", "oneOf", "allOf"];

function hasRootUnion(schema) {
  return UNION_KEYWORDS.some((keyword) => Array.isArray(schema[keyword]));
}

// An explicit object type can coexist with union constraints. The properties
// fallback covers object schemas that omit type.
export function hasObjectRoot(schema) {
  if (!isPlainObject(schema)) return false;
  if (schema.type !== undefined) return schema.type === "object";
  return isPlainObject(schema.properties);
}

// Drop enum and const values that contradict their declared type. Coercing a
// value would tell the model to send an argument the app never requested.

const MAX_LITERAL_DEPTH = 32;
const SCHEMA_MAP_KEYWORDS = ["properties", "patternProperties", "$defs", "definitions"];
const SCHEMA_LIST_KEYWORDS = ["anyOf", "oneOf", "allOf", "prefixItems"];
const SCHEMA_CHILD_KEYWORDS = [
  "items",
  "additionalProperties",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "propertyNames",
];

function jsonTypeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "object") return "object";
  return undefined;
}

function declaredTypes(schema) {
  if (typeof schema.type === "string") return [schema.type];
  if (Array.isArray(schema.type)) return schema.type.filter((entry) => typeof entry === "string");
  return [];
}

function matchesDeclaredType(value, types) {
  const actual = jsonTypeOf(value);
  if (actual === undefined) return false;
  if (types.includes(actual)) return true;
  // JSON Schema counts every integer as a number.
  return actual === "integer" && types.includes("number");
}

// Returns `schema` by identity when nothing contradicts, so a clean toolset
// costs one walk and no copy, and the client's object is never mutated.
function normalizeSchemaLiterals(schema, depth = 0) {
  if (!isPlainObject(schema) || depth > MAX_LITERAL_DEPTH) return schema;
  let next = schema;
  const replace = (key, value) => {
    if (next === schema) next = { ...schema };
    if (value === undefined) delete next[key];
    else next[key] = value;
  };

  const types = declaredTypes(schema);
  if (types.length) {
    if (Array.isArray(schema.enum)) {
      const kept = schema.enum.filter((value) => matchesDeclaredType(value, types));
      if (kept.length !== schema.enum.length) replace("enum", kept.length ? kept : undefined);
    }
    if ("const" in schema && !matchesDeclaredType(schema.const, types)) {
      replace("const", undefined);
    }
  }

  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    const node = schema[keyword];
    if (!isPlainObject(node)) continue;
    let changed = false;
    const rewritten = {};
    for (const [name, child] of Object.entries(node)) {
      const sanitized = normalizeSchemaLiterals(child, depth + 1);
      if (sanitized !== child) changed = true;
      rewritten[name] = sanitized;
    }
    if (changed) replace(keyword, rewritten);
  }

  for (const keyword of [...SCHEMA_LIST_KEYWORDS, ...SCHEMA_CHILD_KEYWORDS]) {
    const node = schema[keyword];
    if (Array.isArray(node)) {
      let changed = false;
      const rewritten = node.map((child) => {
        const sanitized = normalizeSchemaLiterals(child, depth + 1);
        if (sanitized !== child) changed = true;
        return sanitized;
      });
      if (changed) replace(keyword, rewritten);
      continue;
    }
    if (!isPlainObject(node)) continue;
    const sanitized = normalizeSchemaLiterals(node, depth + 1);
    if (sanitized !== node) replace(keyword, sanitized);
  }

  return next;
}

// The one provider-facing normalization: literals aligned with the type their
// own node declares, and object evidence made explicit at a union root. Returns
// `schema` unchanged when neither applies. Unresolved or primitive-only unions
// remain unchanged; this does not claim provider support for nonobject arguments.
// A root `type` array that offers "object" among others -- the nullable object
// root. Narrow on purpose: an array that cannot be an object at all is left
// alone, because collapsing it would replace a real schema with one accepting
// anything, which is the trade this function exists to avoid.
function hasNullableObjectRoot(schema) {
  return Array.isArray(schema.type) && schema.type.includes("object");
}

export function providerToolSchema(schema) {
  const normalized = normalizeSchemaLiterals(schema);
  if (!isPlainObject(normalized)) return normalized;
  if (normalized.type === "object") return normalized;
  // Narrowing the root type can make previously compatible root literals
  // contradictory. Apply the same literal policy to the resulting schema.
  if (hasNullableObjectRoot(normalized)) return normalizeSchemaLiterals({ ...normalized, type: "object" });
  if (normalized.type !== undefined || !hasRootUnion(normalized)) return normalized;
  return objectBranches(normalized, normalized, new Set()).length
    ? normalizeSchemaLiterals({ ...normalized, type: "object" })
    : normalized;
}
