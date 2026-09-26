import assert from "node:assert/strict";
import test from "node:test";
import { parseStatus } from "../dist/routerd.js";

test("parseStatus: only an integer port in range counts", () => {
  assert.equal(parseStatus('{"port": 48000}').port, 48000);
  for (const bad of ['{"port": 47821.5}', '{"port": "8080"}', '{"port": 70000}', '{"port": -1}', "not json"]) {
    assert.equal(parseStatus(bad).port, 47821, bad);
  }
});
