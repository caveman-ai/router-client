# caveman-router Claude Code plugin

The same hooks `caveman-router setup` writes into `~/.claude/settings.json`,
as a Claude Code plugin (`.claude-plugin/plugin.json` + `hooks/hooks.json`).

```
/plugin marketplace add caveman-ai/router-client
/plugin install caveman-router@caveman
```

The hooks call `caveman-router hook claude-code`, so install the CLI first:
`npm i -g @caveman-ai/router-setup`. A plugin cannot set the base URL, the
custom headers or the statusline, so run `caveman-router setup --harness
claude-code` for those; with the plugin enabled, setup leaves the hooks to it
and writes none into settings.json.
