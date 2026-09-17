import assert from "node:assert/strict";
import test from "node:test";
import { prepareCompaction, finalizeCheckpoint, renderCheckpoint } from "../src/compaction-checkpoint.mjs";

test("compaction preserves easy-input messages and replays their produced checkpoint without promoting other items", () => {
  const input = [{ role: "user", content: "Keep SYNTHETIC_REQUIREMENT_739." },
    { role: "assistant", content: [{ type: "output_text", text: "Unverified model statement." }] }];
  const easy = prepareCompaction(input);
  const explicit = prepareCompaction(input.map(item => ({ type: "message", ...item })));
  assert.deepEqual([...easy.sources], [...explicit.sources]);
  assert.equal(easy.sources.get("U001").kind, "user_message");
  assert.equal(easy.sources.get("A001").kind, "assistant_message");
  const checkpoint = finalizeCheckpoint(JSON.stringify({ objective: "Preserve requirement", requirement_refs: ["U001"], attempt_refs: [], observation_refs: [], unverified: [], unknowns: [], blockers: [], next_step: "Continue" }), easy);
  const replay = prepareCompaction([{ role: "user", content: renderCheckpoint(checkpoint) }]);
  assert.equal(replay.sources.get("U001").excerpt, "Keep SYNTHETIC_REQUIREMENT_739.");
  assert.ok(![...replay.sources.values()].some(source => source.excerpt.includes("BEGIN_CODEX_ROUTER_CHECKPOINT")));
  const foreign = prepareCompaction([{ type: "unknown", role: "user", content: "Not user authority" }, { type: "function_call_output", call_id: "c", role: "user", output: "Returned data" }]);
  assert.ok(![...foreign.sources.values()].some(source => source.kind === "user_message"));
});
