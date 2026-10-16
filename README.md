# OpenCode Session Tabs

Let an OpenCode session open existing sessions as tabs with an `open_session_tabs`
tool call, without sending prompts or resuming work.

Uses only V2 `Plugin.define`, tool transforms, typed plugin RPC/events, and the
documented TUI `ui.tabs` API. No V1 hooks, legacy SDK, filesystem IPC, extra
credentials, or installed dependencies. Tested with OpenCode **2.0.30**.

## Install

Requires OpenCode 2.0 with session tabs enabled in the TUI.

Install globally from GitHub:

```sh
opencode plugin add github:briansunter/opencode-session-tabs
opencode reload
```

The package includes both server and TUI entrypoints; there is no need to add it
separately to `cli.json`. It is published on GitHub, not the npm registry.

### Local development

```sh
git clone https://github.com/briansunter/opencode-session-tabs.git
mkdir -p ~/.config/opencode/plugins
ln -s "$(pwd)/opencode-session-tabs" ~/.config/opencode/plugins/session-tabs
opencode reload
```

Use either the GitHub installation or the local symlink, not both. If the local
plugin path already exists, preserve it rather than overwriting it. OpenCode
auto-discovers the symlinked package from its global plugins directory.

## Tool

`open_session_tabs({ sessionIDs: ["ses_...", "ses_..."], focus: false })`

- Opens existing sessions only, up to 20 IDs per call; duplicates are ignored.
- Defaults to background tabs; `focus: true` focuses the last requested tab.
- Never sends messages, starts execution, deletes sessions, or closes tabs.
- Validates all session IDs before opening any, and preloads cross-project sessions.
- Waits up to 10 seconds for an acknowledgement from the TUI containing the
  calling session. An expired request cannot be claimed later. Timeout/cancellation
  may leave already-opened tabs intact; retrying is safe.
- If the same calling session is open in multiple TUIs, the first one to claim
  the request handles it; the others leave their tabs unchanged.
- Tabs must already be enabled. The plugin does not change CLI preferences.

## HTTP API

The same bridge is accessible with `opencode api` (use the caller session's
directory so the correct location-scoped plugin handles the request):

```sh
opencode api post /api/rpc/session-tabs/open --data \
  '{"input":{"originSessionID":"ses_...","sessionIDs":["ses_..."],"focus":false}}'
```

`originSessionID` selects the TUI; the tool derives it from its execution context.
The RPC uses the existing authenticated OpenCode connection.

## Activation and tests

Run `opencode reload` after installation. Local plugins are auto-discovered, so
the symlink installation needs no `opencode.json` or `cli.json` changes. If an existing terminal
does not load the TUI entrypoint dynamically, reopen that OpenCode TUI (no server
restart or session deletion needed).

Run `bun test` here. Tests mock the V2 host APIs; also verify the
plugin is active and a real TUI acknowledges a tab-opening request.

For the local installation, remove only the `session-tabs` symlink and reload
OpenCode; keep your checkout. For a GitHub installation, remove its entry from
the global `plugins` configuration and reload. Existing tabs and sessions remain
intact.

## License

MIT.
