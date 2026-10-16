# OpenCode Session Tabs

**Ask your agent to open other sessions as tabs—without restarting their work.**

Adds one tool, `open_session_tabs`, to OpenCode's terminal interface (TUI).
Great for bringing a few related conversations back into view while keeping your
current conversation focused.

Uses only V2 `Plugin.define`, tool transforms, typed plugin RPC/events, and the
documented TUI `ui.tabs` API. No V1 hooks, legacy SDK, filesystem IPC, extra
credentials, or installed dependencies. Tested with OpenCode **2.0.30**.

## Quick start

### 1. Install

Run these in your shell:

```sh
opencode plugin add github:briansunter/opencode-session-tabs
opencode reload
```

Requires **OpenCode 2.0**, not V1. Check with `opencode --version`.
The package includes both server and TUI entrypoints; there is no need to add it
separately to `cli.json`, install dependencies, or create an API key.
It is published on GitHub, not the npm registry.

### 2. Ask OpenCode

In an open OpenCode terminal session, paste:

> Use open_session_tabs to open this current session as a tab. Keep focus here
> and don't send any messages to other sessions.

This is a safe first check: the tool should confirm the current session is
already open, or add its tab if needed.

Then try:

> List my recent sessions so I can choose which ones to open as tabs.

After choosing sessions:

> Open those three sessions as background tabs. Keep this conversation focused
> and don't resume their work.

**The plugin opens tabs; it does not find sessions or decide which work is
unfinished.** The agent can use OpenCode's session API or CLI for discovery, then
pass the chosen IDs to this tool.

### 3. Check the result

The selected sessions appear in the tab strip. Your current tab stays selected
unless you explicitly ask to switch. Opening a tab does not send a prompt or
restart an interrupted agent.

If you cannot see tabs, press **Ctrl+P → Open settings** and enable session tabs.
See [Troubleshooting](#troubleshooting) below.

## Everyday examples

| What you want | What to ask |
| --- | --- |
| Open known sessions | “Use open_session_tabs for these session IDs: …” |
| Keep reading here | “Open them in background tabs and keep focus here.” |
| Switch after opening | “Open these sessions and focus the last one.” |
| Review unfinished work | “Find recent sessions with pending work, show me the list, then open the ones I choose.” |

To find IDs yourself, run this in your shell:

```sh
opencode session list --max-count 20 --format json
```

Copy the full session IDs from the output. They begin with `ses`. You do not
need to write code or call the HTTP API for normal use.

## Tool reference

This is an **agent tool call**, not a shell command or slash command:

```js
open_session_tabs({
  sessionIDs: ["ses_example_one", "ses_example_two"],
  focus: false,
})
```

Replace the example IDs with real IDs from your OpenCode server.

| Argument | Required | Meaning |
| --- | --- | --- |
| `sessionIDs` | Yes | 1–20 existing session IDs, including sessions from different projects. |
| `focus` | No | Defaults to `false`. Set `true` to focus the last requested session. |

Example successful result:

```json
{
  "opened": ["ses_example_two"],
  "alreadyOpen": ["ses_example_one"],
  "focused": false
}
```

`opened` lists newly added tabs; `alreadyOpen` lists tabs that were already there.
Repeated calls do not create duplicate tabs.

### Safety and limits

- Opens existing sessions only, up to 20 IDs per call; duplicates are ignored.
- Never sends messages, starts execution, creates or deletes sessions, or closes tabs.
- Checks that every requested session exists before requesting any tabs.
- Waits for the TUI to confirm the requested tabs instead of assuming success.
- The calling session must be open in a connected TUI with this plugin loaded.
  Headless `opencode run`, Mini, web, and desktop-only sessions cannot supply
  the required full-screen TUI tab interface on their own.
- If the calling session is open in multiple TUIs, the first one to claim the
  request handles it; the others leave their tabs unchanged.
- Confirmation times out after 10 seconds. A timeout or cancellation can leave
  tabs already opened intact; retrying the same IDs is safe.
- Tab preferences, session contents, and model settings are not changed.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Agent cannot find `open_session_tabs` | Run `opencode plugin list` to check installation, then `opencode reload`. If needed, reopen the TUI with the same session. |
| “Session tabs are disabled” | Enable tabs through **Ctrl+P → Open settings**, or merge the setting below into your CLI config. |
| “No TUI confirmation received” | Keep the calling session open in a full-screen TUI connected to the same server. Reload the plugin or reopen the TUI, then retry. |
| Session ID is invalid or not found | Copy the full ID from `opencode session list --max-count 20 --format json`. The session must exist on the connected server. |
| “OpenCode did not retain tab …” | Some tabs may have opened. Let the TUI finish loading, then retry the same IDs; existing tabs are skipped. |
| Plugin was unloaded during a call | A reload interrupted the request. Wait for reload to finish, then retry. |

If enabling tabs manually, **merge** this into `~/.config/opencode/cli.json`;
do not replace your other settings. If `XDG_CONFIG_HOME` is set, use
`$XDG_CONFIG_HOME/opencode/cli.json` instead.

```json
{
  "tabs": {
    "mode": "on"
  }
}
```

See OpenCode's [tab settings](https://opencode.ai/v2/docs/cli/config#tabs).
Do not install both a local checkout and the GitHub package at the same time.

## Local development

```sh
git clone https://github.com/briansunter/opencode-session-tabs.git
mkdir -p ~/.config/opencode/plugins
ln -s "$(pwd)/opencode-session-tabs" ~/.config/opencode/plugins/session-tabs
opencode reload
```

Use either the GitHub installation or the local symlink, not both. If the local
plugin path already exists, preserve it rather than overwriting it. OpenCode
auto-discovers the symlinked package from its global plugins directory.

Run the tests from the checkout:

```sh
cd opencode-session-tabs
bun test
```

Tests cover validation, duplicate handling, background/focused tabs, delayed TUI
updates, routing, acknowledgements, timeouts, cancellation, and partial failures.

### How it works

1. `index.ts` registers the tool with OpenCode's V2 server plugin API.
2. The tool validates the sessions and emits an RPC request defined in `rpc.ts`.
3. `tui.ts` listens for requests from sessions open in that TUI.
4. One TUI claims the request, preloads the sessions, and opens their tabs.
5. The TUI acknowledges the result, which the tool returns to the agent.

`core.js` contains the bridge and tab logic; `core.test.js` tests it against mocked
host APIs. The plugin uses OpenCode's existing authenticated connection—no extra
service, database, or credential store.

## Advanced: HTTP API

The same bridge is accessible with `opencode api` (use the caller session's
directory so the correct location-scoped plugin handles the request):

```sh
opencode api post /api/rpc/session-tabs/open --data \
  '{"input":{"originSessionID":"ses_...","sessionIDs":["ses_..."],"focus":false}}'
```

`originSessionID` selects the TUI; the tool derives it from its execution context.
The RPC uses the existing authenticated OpenCode connection.

## Reloading and uninstalling

Run `opencode reload` after installation. Local plugins are auto-discovered, so
the symlink installation needs no `opencode.json` or `cli.json` changes. If an
existing terminal does not load the TUI entrypoint dynamically, reopen that
OpenCode TUI (no server restart or session deletion needed).

For the local installation, remove only the `session-tabs` symlink and reload
OpenCode; keep your checkout. For a GitHub installation, remove its entry from
the global `plugins` configuration and reload. Existing tabs and sessions remain
intact.

## License

[MIT](LICENSE) © 2026 Brian Sunter. Free to use, modify, and redistribute,
including commercially, with the license notice retained.
