import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyKeys, formatJson, parseJsonObject, readText, recordFor, restoreKeys, restoreManaged, writeManaged } from "./files.js";
import type { SetupState } from "./files.js";
import type { PoolModel } from "./routerd.js";

// OpenCode: a `caveman` provider in the global opencode.json (Anthropic
// Messages to the daemon via @ai-sdk/anthropic) and a plugin file OpenCode
// auto-loads from {plugin,plugins}/*.{ts,js} in its config directory.

export function opencodeDir(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode");
}

export const opencodeConfigPath = (): string => join(opencodeDir(), "opencode.json");
export const opencodePluginPath = (): string => join(opencodeDir(), "plugins", "caveman-router.js");
export const PLUGIN_SOURCE = (): string => readFileSync(fileURLToPath(new URL("../assets/opencode-plugin.js", import.meta.url)), "utf8");

export type OpencodeOptions = { port: number; token: string; mode: string; pool: PoolModel[] };

function limit(models: PoolModel[]): { context: number; output: number } | undefined {
  const contexts = models.map((model) => model.context);
  const outputs = models.map((model) => model.output);
  if (contexts.some((value) => value === undefined) || outputs.some((value) => value === undefined)) return undefined;
  return { context: Math.min(...(contexts as number[])), output: Math.min(...(outputs as number[])) };
}

export function opencodeProvider(options: OpencodeOptions): Record<string, unknown> {
  const models: Record<string, unknown> = {};
  // `auto` may land on any pool model, so it is declared with the pool's
  // smallest limits; unknown limits are left for OpenCode to default.
  const autoLimit = limit(options.pool);
  models.auto = { name: "auto (Caveman routed)", ...(autoLimit ? { limit: autoLimit } : {}) };
  for (const model of options.pool) {
    const own = limit([model]);
    models[model.id] = { name: model.id, ...(own ? { limit: own } : {}) };
  }
  return {
    npm: "@ai-sdk/anthropic",
    name: "Caveman (local router)",
    options: {
      baseURL: `http://127.0.0.1:${options.port}/v1`,
      // The LOCAL token, not a provider key: @ai-sdk/anthropic needs an
      // apiKey, and the daemon holds the real ones.
      apiKey: options.token,
      headers: { "x-caveman-local-token": options.token, "x-cave-routing-mode": options.mode },
    },
    models,
  };
}

export type OpencodeResult = { paths: string[]; changed: boolean; notes: string[] };

export function configureOpencode(state: SetupState, options: OpencodeOptions): OpencodeResult {
  const configPath = opencodeConfigPath();
  const text = readText(configPath);
  const root = parseJsonObject(text);
  if (!root) throw new Error(`${configPath} is not plain JSON (comments?); not touching it`);
  const record = recordFor(state, configPath);
  applyKeys(root, record, { "provider.caveman": opencodeProvider(options) });
  let changed = writeManaged(state, configPath, formatJson(root, text));
  changed = writeManaged(state, opencodePluginPath(), PLUGIN_SOURCE()) || changed;
  const notes: string[] = [];
  if (readText(join(opencodeDir(), "opencode.jsonc")) !== undefined) notes.push(`${join(opencodeDir(), "opencode.jsonc")} exists too; OpenCode merges both`);
  return { paths: [configPath, opencodePluginPath()], changed, notes };
}

export function teardownOpencode(state: SetupState): string[] {
  const configPath = opencodeConfigPath();
  const pluginPath = opencodePluginPath();
  return [
    `${configPath}: ${restoreManaged(state, configPath, (current, record) => {
      const root = parseJsonObject(current);
      if (!root) return null;
      restoreKeys(root, record);
      return formatJson(root, current);
    })}`,
    // A plugin file someone edited is theirs now: left in place.
    `${pluginPath}: ${restoreManaged(state, pluginPath, () => null)}`,
  ];
}
