#!/usr/bin/env node
import { configPath, latencyP95, routerKey, routerOn, routerURL, writeConfig } from "./config.js";
import { hooksInstalled, installHooks, settingsPath, uninstallHooks } from "./install.js";
import { DEFAULT_MODEL, STATUSLINE_COMMAND, configuredModel, setModel, setupClaudeCode, statuslineHook, teardownClaudeCode, validModel } from "./claude-code.js";
import { spawnHook } from "./index.js";

// No subcommand means Claude Code invoked us as the hook itself: the hook is
// the default so the settings.json entry is the bare bin name.
const [sub, ...rest] = process.argv.slice(2);
const project = rest.includes("--project");

function flag(name: string): string | undefined {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? rest[index + 1] : undefined;
}

function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { text += chunk; });
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", () => resolve(text));
  });
}

switch (sub) {
  case undefined:
    await spawnHook();
    break;
  case "install": {
    const path = settingsPath(project);
    if (!installHooks(path)) {
      console.error(`cannot update ${path}; not modifying it`);
      process.exitCode = 1;
      break;
    }
    console.log(`installed caveman-router-hook in ${path}`);
    if (!routerKey()) console.log("no router key yet: caveman-router-hook login --key <key>");
    break;
  }
  case "uninstall": {
    const path = settingsPath(project);
    console.log(uninstallHooks(path) ? `removed caveman-router-hook from ${path}` : `no caveman-router-hook entries in ${path}`);
    break;
  }
  case "login": {
    const url = flag("url");
    const key = flag("key");
    if (!url && !key) {
      console.error("usage: caveman-router-hook login [--url <url>] [--key <key>]");
      process.exitCode = 1;
      break;
    }
    writeConfig({ ...(url ? { url } : {}), ...(key ? { key } : {}) });
    console.log(`wrote ${configPath()}`);
    break;
  }
  case "setup": {
    if (rest[0] !== "claude-code") {
      console.error("usage: caveman-router-hook setup claude-code [--url <url>] [--key <key>] [--model <model>] [--statusline] [--project]");
      process.exitCode = 1;
      break;
    }
    const url = flag("url") ?? routerURL();
    const key = flag("key") ?? routerKey();
    const model = flag("model") ?? DEFAULT_MODEL;
    if (!validModel(model)) {
      console.error(`not a model name: ${model} (expected auto, auto:<a>,<b> or vendor/model)`);
      process.exitCode = 1;
      break;
    }
    // Persist what was passed so `statusline` and the spawn hook reach the same
    // router without a second login.
    if (flag("url") || flag("key")) writeConfig({ ...(flag("url") ? { url } : {}), ...(flag("key") ? { key } : {}) });
    const path = settingsPath(project);
    const result = setupClaudeCode(path, { url, key, model, statusline: rest.includes("--statusline") });
    if (!result) {
      console.error(`cannot update ${path}; not modifying it`);
      process.exitCode = 1;
      break;
    }
    console.log(`updated ${path}`);
    console.log(`  env.ANTHROPIC_BASE_URL   ${url}`);
    console.log(`  env.ANTHROPIC_AUTH_TOKEN ${key ? "set" : "empty (caveman-router-hook login --key <key>)"}`);
    console.log(`  model                    ${model}`);
    if (result.statuslineTaken) {
      console.log("  statusLine               kept yours; chain ours into it:");
      console.log(`    ${STATUSLINE_COMMAND}`);
    } else if (rest.includes("--statusline")) {
      console.log(`  statusLine               ${STATUSLINE_COMMAND}`);
    }
    console.log("  hooks                    PreToolUse(Agent|Task), SubagentStop");
    console.log(result.changed.length ? "restart Claude Code" : "already set up; restart Claude Code if it is running");
    break;
  }
  case "teardown": {
    if (rest[0] !== "claude-code") {
      console.error("usage: caveman-router-hook teardown claude-code [--project]");
      process.exitCode = 1;
      break;
    }
    const path = settingsPath(project);
    const removed = teardownClaudeCode(path);
    if (!removed) {
      console.error(`cannot update ${path}; not modifying it`);
      process.exitCode = 1;
      break;
    }
    console.log(removed.length ? `removed from ${path}: ${removed.join(", ")}` : `nothing of ours in ${path}`);
    console.log("restart Claude Code");
    break;
  }
  case "model": {
    const path = settingsPath(project);
    const name = rest.find((value) => !value.startsWith("--"));
    if (!name) {
      // Configured only: the last model the router actually used is one command
      // away (`statusline`) and reading it here would cost a network call.
      console.log(configuredModel(path) ?? `not set (caveman-router-hook setup claude-code)`);
      break;
    }
    if (!validModel(name)) {
      console.error(`not a model name: ${name} (expected auto, auto:<a>,<b> or vendor/model)`);
      process.exitCode = 1;
      break;
    }
    if (!setModel(path, name)) {
      console.error(`cannot update ${path}; not modifying it`);
      process.exitCode = 1;
      break;
    }
    console.log(`Claude Code will use ${name} after restart; /model inside Claude Code still works`);
    break;
  }
  case "statusline": {
    // The hot path: one line on stdout, always exit 0, never stderr.
    try { console.log(await statuslineHook(await readStdin())); } catch { console.log(""); }
    break;
  }
  case "on":
  case "off":
    writeConfig({ router: sub });
    console.log(`router ${sub}`);
    break;
  case "status": {
    const p95 = latencyP95();
    console.log(`router      ${routerOn() ? "on" : "off"}`);
    console.log(`url         ${routerURL()}`);
    console.log(`key         ${routerKey() ? "set" : "missing (ROUTER_API_KEY or caveman-router-hook login --key)"}`);
    console.log(`hook        ${hooksInstalled(settingsPath(project)) ? "installed" : "not installed"} (${settingsPath(project)})`);
    console.log(`answers     ${p95 === undefined ? "none measured yet" : `${(p95 / 1000).toFixed(1)} s (p95, last 20)`}`);
    break;
  }
  default:
    console.error("usage: caveman-router-hook [setup claude-code|teardown claude-code|model|statusline|install|uninstall|login|on|off|status] [--project]");
    process.exitCode = 1;
}
