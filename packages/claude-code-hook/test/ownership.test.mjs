import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hooksInstalled, installHooks, uninstallHooks } from "../dist/install.js";

for (const event of ["PreToolUse", "SubagentStop"]) {
  test(`uninstall preserves other hooks sharing a ${event} entry`, () => {
    const dir = mkdtempSync(join(tmpdir(), "router-owned-hooks-"));
    try {
      const path = join(dir, "settings.json");
      const foreign = { type: "command", command: "audit-other-tool", timeout: 15 };
      const entry = { matcher: "Agent|Task", custom: "preserve", hooks: [foreign, { type: "command", command: "caveman-router-hook" }] };
      writeFileSync(path, JSON.stringify({ model: "opus", hooks: { [event]: [entry] } }));
      assert.equal(uninstallHooks(path), true);
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { model: "opus", hooks: { [event]: [{ ...entry, hooks: [foreign] }] } });
      assert.equal(uninstallHooks(path), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("similarly named commands do not count as installer-owned hooks", () => {
  const dir = mkdtempSync(join(tmpdir(), "router-owned-hooks-"));
  try {
    const path = join(dir, "settings.json");
    const foreign = [
      { type: "command", command: "my-caveman-router-hook-helper" },
      { type: "command", command: "echo caveman-router-hook" },
      { type: "prompt", command: "caveman-router-hook", prompt: "keep" },
    ];
    const entry = { matcher: "Agent|Task", hooks: foreign };
    const original = { hooks: { PreToolUse: [entry], SubagentStop: [entry] } };
    writeFileSync(path, JSON.stringify(original));
    assert.equal(hooksInstalled(path), false);
    assert.equal(uninstallHooks(path), false);
    assert.equal(installHooks(path), true);
    assert.equal(hooksInstalled(path), true);
    const installed = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(installed.hooks.PreToolUse.length, 2);
    assert.deepEqual(installed.hooks.PreToolUse[0], entry);
    assert.equal(uninstallHooks(path), true);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), original);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("uninstall removes only owned hooks across mixed positions and duplicates", () => {
  const dir = mkdtempSync(join(tmpdir(), "router-owned-hooks-"));
  try {
    const path = join(dir, "settings.json");
    const owned = { type: "command", command: "caveman-router-hook" };
    for (const event of ["PreToolUse", "SubagentStop"]) {
      for (let count = 0; count <= 8; count++) {
        const foreign = Array.from({ length: count }, (_, index) => ({ type: "command", command: `audit-${index}` }));
        for (let position = 0; position <= count; position++) {
          const mixed = [...foreign.slice(0, position), owned, owned, ...foreign.slice(position)];
          const otherEvent = event === "PreToolUse" ? "SubagentStop" : "PreToolUse";
          const metadata = { matcher: "custom", timeout: 25 };
          const unrelated = { hooks: [null, { type: "prompt", prompt: "keep" }] };
          const hooks = { [event]: [unrelated, { ...metadata, hooks: mixed }], [otherEvent]: [], Stop: [unrelated] };
          writeFileSync(path, JSON.stringify({ permissions: { allow: ["Read"] }, hooks }));
          assert.equal(uninstallHooks(path), true);
          const expected = { ...hooks, [event]: count ? [unrelated, { ...metadata, hooks: foreign }] : [unrelated] };
          assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { permissions: { allow: ["Read"] }, hooks: expected });
          assert.equal(uninstallHooks(path), false);
        }
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
