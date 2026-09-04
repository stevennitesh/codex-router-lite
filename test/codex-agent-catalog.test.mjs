import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { syncRoutedCodexAgents } from "../src/codex-agent-catalog.mjs";

test("routed child pins its supported default effort instead of inheriting the parent", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-agent-catalog-"));
  try {
    const [written] = syncRoutedCodexAgents([
      {
        slug: "openrouter/glm-5.3-flash-gmicloud",
        displayName: "GLM-5.3-Flash (OpenRouter, GMICloud)",
        defaultEffort: "max",
        reasoningLevels: [
          { effort: "low" },
          { effort: "high" },
          { effort: "max" },
        ],
      },
    ], root).written;
    const contents = readFileSync(written.path, "utf8");
    assert.match(contents, /^model = "openrouter\/glm-5\.3-flash-gmicloud"$/mu);
    assert.match(contents, /^model_reasoning_effort = "max"$/mu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("routed child rejects a default effort outside its advertised ladder", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-agent-catalog-"));
  try {
    assert.throws(
      () => syncRoutedCodexAgents([
        {
          slug: "openrouter/glm-5.3-flash-gmicloud",
          displayName: "GLM-5.3-Flash (OpenRouter, GMICloud)",
          defaultEffort: "medium",
          reasoningLevels: [{ effort: "low" }, { effort: "high" }, { effort: "max" }],
        },
      ], root),
      /supported default effort/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
