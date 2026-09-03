// The OpenRouter GLM route receives Codex tools through LiteLLM's Chat
// Completions adapter, which requires an object parameter root. Codex's
// `codex_app__automation_update` instead uses a root `oneOf` across its modes.
//
// Flattening keeps the tool callable: the branches are merged into one object
// so the model still sees every field it may send, with `required` narrowed to
// the fields every branch demands (usually none, because the branches are
// alternatives). Validation of which combination is legal stays where it
// already was -- the Codex app executes these calls and checks its own
// arguments.

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_DEPTH = 8;

// Resolves only local URI-fragment JSON Pointers: `#` and `#/...`. RFC 6901
// fragment decoding happens before `~1` / `~0` token decoding. Object own keys
// and canonical in-range array indexes are traversable; malformed fragments,
// anchors such as `#node`, and unsupported targets remain unresolved. The
// cycle repair deliberately does not infer semantics for `$dynamicRef` or
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

// Collect object branches from a bounded root union. Local references are
// resolved only far enough to preserve the fields exposed by that union.
function objectBranches(schema, root, seen, depth = 0) {
  if (!isPlainObject(schema) || depth > MAX_DEPTH) return [];
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
  if (schema.type === "object" || isPlainObject(schema.properties)) branches.push(schema);
  return branches;
}

const UNION_KEYWORDS = ["anyOf", "oneOf", "allOf"];

function hasRootUnion(schema) {
  return UNION_KEYWORDS.some((keyword) => Array.isArray(schema[keyword]));
}

// A union keyword or nullable type is not the plain object root required by
// the GLM tool bridge. The properties fallback covers schemas with no type.
export function hasObjectRoot(schema) {
  if (!isPlainObject(schema)) return false;
  if (hasRootUnion(schema)) return false;
  if (schema.type !== undefined) return schema.type === "object";
  return isPlainObject(schema.properties);
}

// Returns `schema` unchanged when its root is already a plain object, so the
// common case costs one type check and no copy.
function objectRootToolSchema(schema) {
  if (!isPlainObject(schema)) return { type: "object", properties: {} };
  if (hasObjectRoot(schema)) return schema;

  const branches = objectBranches(schema, schema, new Set());
  const properties = {};
  // Root-level properties apply to every branch, so they win over branch
  // definitions of the same name.
  if (isPlainObject(schema.properties)) Object.assign(properties, schema.properties);
  for (const branch of branches) {
    if (!isPlainObject(branch.properties)) continue;
    for (const [name, property] of Object.entries(branch.properties)) {
      if (!(name in properties)) properties[name] = property;
    }
  }
  // Required only where every branch requires it: a field the view branch
  // demands is optional for the delete branch, and marking it required would
  // reject calls the app accepts. Root-level requirements are separate -- they
  // bind every branch, so they survive whatever the branches disagree about.
  const rootRequired = Array.isArray(schema.required) ? schema.required : [];
  const unionBranches = branches.filter((branch) => branch !== schema);
  const shared = unionBranches.length
    ? unionBranches
        .map((branch) => (Array.isArray(branch.required) ? branch.required : []))
        .reduce((left, right) => left.filter((name) => right.includes(name)))
    : [];
  const required = [...new Set([...rootRequired, ...shared])];

  return {
    ...(schema.$schema ? { $schema: schema.$schema } : {}),
    ...(schema.$defs ? { $defs: schema.$defs } : {}),
    ...(schema.definitions ? { definitions: schema.definitions } : {}),
    ...(typeof schema.description === "string" ? { description: schema.description } : {}),
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    // The merged object cannot describe which branch a call belongs to, so it
    // must not reject fields that only one branch declares. A root that was
    // rewritten without merging anything -- a nullable `type: ["object","null"]`
    // becoming plain `"object"` -- has no such ambiguity, so it keeps whatever
    // it declared rather than being quietly opened up.
    ...(unionBranches.length || schema.additionalProperties === undefined
      ? { additionalProperties: true }
      : { additionalProperties: schema.additionalProperties }),
  };
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
// own node declares, and a union root merged into a plain object. Returns
// `schema` unchanged when neither applies.
//
// Keep this narrower than objectRootToolSchema alone. An unusual server schema
// must not be replaced with an unconstrained object unless its root is the
// known union or nullable-object shape.
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
  // The repair preserves properties, required fields, and
  // additionalProperties. Only the unusable root-level null alternative is
  // dropped.
  if (!hasRootUnion(normalized) && !hasNullableObjectRoot(normalized)) return normalized;
  return objectRootToolSchema(normalized);
}
