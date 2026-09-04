import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMultiAgentCapabilities,
  subagentEligibleModels,
} from "../src/multi-agent-state.mjs";

const certified = {
  slug: "openrouter/glm-5.3-flash",
  multiAgentVersion: "v2",
};
const uncertified = {
  slug: "example/uncertified",
  multiAgentVersion: "v1",
};

test("local settings cannot promote an uncertified route", () => {
  for (const settings of [
    { mode: "all", enabled: [], disabled: [] },
    { mode: "selected", enabled: [uncertified.slug], disabled: [] },
  ]) {
    const [route] = applyMultiAgentCapabilities([uncertified], settings);
    assert.equal(route.multiAgentVersion, "v1");
  }
});

test("local settings only filter certified routes", () => {
  const visible = applyMultiAgentCapabilities(
    [certified],
    { mode: "proven", enabled: [], disabled: [] },
  );
  assert.equal(visible[0].multiAgentVersion, "v2");

  for (const [settings, hidden] of [
    [{ mode: "proven", enabled: [], disabled: [certified.slug] }, new Set()],
    [{ mode: "selected", enabled: [], disabled: [] }, new Set()],
    [{ mode: "all", enabled: [], disabled: [] }, new Set([certified.slug])],
  ]) {
    const [route] = applyMultiAgentCapabilities([certified], settings, { hidden });
    assert.equal(route.multiAgentVersion, "v1");
  }
});

test("eligibility contains only certified routes left by local filtering", () => {
  const settings = {
    mode: "selected",
    enabled: [certified.slug, uncertified.slug],
    disabled: [],
  };
  const filtered = applyMultiAgentCapabilities([certified, uncertified], settings);
  assert.deepEqual(
    subagentEligibleModels(filtered, settings).map(({ slug }) => slug),
    [certified.slug],
  );
});
