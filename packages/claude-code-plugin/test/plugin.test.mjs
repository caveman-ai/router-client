import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CLAUDE_HOOKS } from "@caveman-ai/router-setup";

const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

test("the plugin ships exactly the hooks setup writes into settings.json", () => {
  assert.deepEqual(json("../hooks/hooks.json").hooks, CLAUDE_HOOKS);
});

test("the manifest and the marketplace entry agree", () => {
  const manifest = json("../.claude-plugin/plugin.json");
  const marketplace = json("../../../.claude-plugin/marketplace.json");
  assert.equal(manifest.name, "caveman-router");
  assert.deepEqual(marketplace.plugins.map((plugin) => [plugin.name, plugin.source]), [["caveman-router", "./packages/claude-code-plugin"]]);
});
