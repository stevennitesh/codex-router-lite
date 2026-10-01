import assert from "node:assert/strict";
import test from "node:test";
import { retryAfterSeconds } from "../src/rate-limit-headers.mjs";

const NOW = Date.UTC(2026, 9, 1, 12);
const headers = value => new Headers({ "retry-after": value });

test("retry delays preserve valid seconds, durations, epochs, and HTTP dates", () => {
  for (const [value, expected] of [
    ["0", 0], [" 60 ", 60], ["2m59.56s", 180], ["1ms", 1],
    [String((NOW + 60_000) / 1000), 60], [String(NOW + 60_000), 60],
    [new Date(NOW + 60_000).toUTCString(), 60],
    [new Date(NOW - 60_000).toUTCString(), 0],
  ]) {
    assert.equal(retryAfterSeconds(headers(value), { now: NOW }), expected, value);
  }
});

test("retry delays reject impossible timestamps and overflowing duration components", () => {
  for (const value of [
    "", "-1", "NaN", "Infinity", "8640000000000001", "1e20",
    "999999999999999h", `${"9".repeat(305)}h`, `${"9".repeat(309)}h`,
    `1h${"9".repeat(309)}m`, `${"9".repeat(309)}s`, `${"9".repeat(309)}ms`,
  ]) {
    assert.equal(retryAfterSeconds(headers(value), { now: NOW }), undefined, value);
  }
  assert.equal(retryAfterSeconds(new Headers(), { now: NOW }), undefined);
});

test("retry delays validate the Date boundary after unit conversion and addition", () => {
  const maximum = 8_640_000_000_000_000;
  assert.equal(retryAfterSeconds(headers(String(maximum)), { now: 0 }), maximum / 1000);
  assert.equal(retryAfterSeconds(headers("2400000000h"), { now: 0 }), maximum / 1000);
  assert.equal(retryAfterSeconds(headers("1ms"), { now: maximum - 1 }), 1);
  assert.equal(retryAfterSeconds(headers("1ms"), { now: maximum }), undefined);
  assert.equal(retryAfterSeconds(headers("1"), { now: maximum }), undefined);
});
