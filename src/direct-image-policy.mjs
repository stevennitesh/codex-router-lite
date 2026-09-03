export const evidenceCache = new Map();

export function supportsImageInput(model) {
  return Array.isArray(model?.inputModalities) && model.inputModalities.includes("image");
}

export function inputHasImage(value) {
  if (Array.isArray(value)) return value.some(inputHasImage);
  if (!value || typeof value !== "object") return false;
  if (value.type === "input_image" || value.type === "image_url") return true;
  return Object.values(value).some(inputHasImage);
}

export function readVisionBridgeSettings() {
  return { enabled: false, engine: undefined, defaulted: false };
}

export function installedNativeVisionEngines() {
  return [];
}

export function resolveVisionEngines() {
  return [];
}

export function hasNativeSession(headers = {}) {
  return Boolean(headers.authorization && headers["chatgpt-account-id"]);
}

export function nativeAccountKey(headers = {}) {
  return String(headers["chatgpt-account-id"] || "");
}

export function stripImages(input) {
  return input;
}

export async function describeImage() {
  throw new Error("Fallback vision is not available; retained routes accept images directly.");
}

export async function substituteImages() {
  throw new Error("Fallback vision is not available; retained routes accept images directly.");
}
