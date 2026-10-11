import path from "node:path";

import { withCatalogPublicationLock } from "./catalog-publication-lock.mjs";
import { readJsonFile } from "./file-probe.mjs";
import { writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

const MODEL_PICKER_STATE_PATH =
  process.env.MODEL_ROUTER_MODEL_PICKER_STATE ||
  path.join(STATE_DIR, "model-picker.json");

// Per-model visibility overrides for the router's client pickers. Hiding a
// model only changes the generated catalogs for this machine; the registry
// stays untouched. `visible` is persisted as well as `hidden`, so an explicit
// "show" choice has a durable, inspectable representation instead of looking
// like the model was never selected simply because it is absent from the
// hidden list.
//
// `hidden` answers "is this model off"; `seeded` answers the different question
// "has this model ever been decided" -- by the operator, or by a default the
// catalog build applied once. Absence from `hidden` cannot answer it, because
// that is also what a model nobody has ever seen looks like, and a default
// that cannot tell the two apart re-applies itself over the operator's choice
// on the next rebuild (see `seedModelsHidden`).
function readPickerState() {
  const empty = {
    hidden: new Set(),
    visible: new Set(),
    seeded: new Set(),
    hasExplicitVisibility: false,
  };
  const observed = readJsonFile(MODEL_PICKER_STATE_PATH);
  if (observed.status === "missing") return empty;
  const parsed = observed.value;
  const slugsValid = (value) => Array.isArray(value) && value.every((slug) => typeof slug === "string" && slug.length > 0);
  if (observed.status !== "present" || parsed?.version !== 1 || !slugsValid(parsed.hidden) ||
      (parsed.visible !== undefined && !slugsValid(parsed.visible)) ||
      (parsed.seeded !== undefined && !slugsValid(parsed.seeded))) {
    throw new Error(`Cannot read model picker settings (${observed.status === "present" ? "invalid" : observed.status}) at ${MODEL_PICKER_STATE_PATH}.`);
  }
  const hidden = new Set(parsed.hidden);
  const seeded = new Set(parsed.seeded || []);
  // `visible` was added after version 1 shipped. For an older file, every
  // seeded model not in `hidden` is an explicit show decision and can be
  // reconstructed without changing the effective picker behavior.
  const hasExplicitVisibility = Array.isArray(parsed.visible);
  const visible = hasExplicitVisibility
    ? new Set(parsed.visible)
    : new Set([...seeded].filter((slug) => !hidden.has(slug)));
  for (const slug of hidden) visible.delete(slug);
  return { hidden, visible, seeded, hasExplicitVisibility };
}

export function readHiddenModels() {
  return readPickerState().hidden;
}

function writePickerState({ hidden, visible, seeded, hasExplicitVisibility = true }) {
  writePrivateJson(MODEL_PICKER_STATE_PATH, {
    version: 1,
    hidden: [...hidden].sort(),
    ...(hasExplicitVisibility
      ? { visible: [...visible].filter((slug) => !hidden.has(slug)).sort() }
      : {}),
    seeded: [...seeded].sort(),
  });
  return modelPickerSnapshot();
}

export function modelPickerSnapshot({ diagnostic = false } = {}) {
  let state;
  try { state = readPickerState(); }
  catch (error) {
    if (!diagnostic) throw error;
    return { path: MODEL_PICKER_STATE_PATH, degraded: error.message };
  }
  return {
    hidden: [...state.hidden].sort(),
    visible: [...state.visible].sort(),
    hasExplicitVisibility: state.hasExplicitVisibility,
    path: MODEL_PICKER_STATE_PATH,
  };
}

export function setModelVisible(slug, visible) {
  return withCatalogPublicationLock(() => setModelsVisible([slug], visible));
}

// Changes only the supplied models so provider-level actions preserve every
// other provider's picker choices.
function setModelsVisible(slugs, visible) {
  const values = [...new Set(slugs.map((slug) => String(slug || "").trim()).filter(Boolean))];
  if (values.length === 0) throw new Error("At least one model slug is required.");
  const { hidden, visible: visibleSet, seeded } = readPickerState();
  for (const value of values) {
    if (visible) {
      hidden.delete(value);
      visibleSet.add(value);
    } else {
      hidden.add(value);
      visibleSet.delete(value);
    }
    // The operator just decided this one. Recording it is what stops a
    // shipped default from quietly undoing the decision later.
    seeded.add(value);
  }
  return writePickerState({ hidden, visible: visibleSet, seeded });
}

// Applies the opt-in default to routed models the operator has never decided.
//
// Idempotent, and silent when there is nothing to record -- this runs on every
// catalog rebuild, and rewriting the operator's picker state to say nothing new
// is how a protected file starts churning.
export function seedModelsHidden(slugs) {
  // The sole production caller is catalog publication, already under this
  // same lock. Operator mutations acquire it before reading their snapshot.
  const values = [...new Set(
    (Array.isArray(slugs) ? slugs : []).map((slug) => String(slug || "").trim()).filter(Boolean),
  )];
  const { hidden, visible, seeded, hasExplicitVisibility } = readPickerState();
  const fresh = values.filter((value) => !seeded.has(value));
  if (fresh.length === 0) return modelPickerSnapshot();
  for (const value of fresh) {
    hidden.add(value);
    visible.delete(value);
    seeded.add(value);
  }
  return writePickerState({ hidden, visible, seeded, hasExplicitVisibility });
}
