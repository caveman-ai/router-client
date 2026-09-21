#!/usr/bin/env node
import { configPath, latencyP95, routerKey, routerOn, routerURL, writeConfig } from "./config.js";
import { hooksInstalled, installHooks, settingsPath, uninstallHooks } from "./install.js";
import { spawnHook } from "./index.js";

// No subcommand means Claude Code invoked us as the hook itself: the hook is
// the default so the settings.json entry is the bare bin name.
const [sub, ...rest] = process.argv.slice(2);
const project = rest.includes("--project");

function flag(name: string): string | undefined {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? rest[index + 1] : undefined;
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
    console.error("usage: caveman-router-hook [install|uninstall|login|on|off|status] [--project]");
    process.exitCode = 1;
}
