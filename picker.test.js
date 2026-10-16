import test from "node:test"
import assert from "node:assert/strict"
import { createSessionPickerController, pickerCommands, runSessionPicker } from "./picker.tsx"
import { discoverSessions } from "./core.js"
import { fakeDialog } from "./dialog-driver.js"

const NOW = 1_700_000_000_000

const sessions = [
  { id: "ses_a", title: "Fix login bug", location: { directory: "/code/app" }, time: { updated: NOW - 60_000 } },
  { id: "ses_b", title: "Write docs", location: { directory: "/code/docs" }, time: { updated: NOW - 5 * 3_600_000 } },
  { id: "ses_c", location: { directory: "/code/app" }, time: { updated: NOW - 2 } },
]

// Rows are newest-first: ses_c (2s), ses_a (1m), ses_b (5h).
const previews = { ses_a: "You: why is login broken?\nAgent: token refresh expired" }

const settle = ms => new Promise(resolve => setTimeout(resolve, ms))

function makeDeps(overrides = {}) {
  const driver = fakeDialog()
  const opened = []
  const saved = []
  const toasts = []
  let controller
  const deps = {
    dialog: driver.dialog,
    layer: () => {},
    shortcut: () => undefined,
    loadSessions: async () => ({ sessions: sessions.slice() }),
    openTabs: async (ids, { focus } = {}) => {
      opened.push({ ids, focus })
      return { opened: ids, alreadyOpen: [], focused: focus === true }
    },
    loadPreviewText: async id => previews[id] ?? "",
    saveWorkspace: async (name, ids) => {
      saved.push({ name, ids })
      return { name, sessionIDs: ids, createdAt: NOW, updatedAt: NOW }
    },
    listWorkspaceNames: async () => [],
    toast: options => toasts.push(options),
    openTabIDs: () => [],
    formatPath: value => value,
    now: () => NOW,
    tabsEnabled: () => true,
    onController: value => {
      controller = value
    },
    ...overrides,
  }
  // Runs a footer-action binding exactly as the host keymap would: the same
  // run function the dialog's keymap layer binds to `bind`.
  const runBind = bind => {
    const command = pickerCommands(controller).find(entry => entry.bind === bind)
    if (!command) throw new Error(`no command bound to ${bind}`)
    return command.run()
  }
  return { driver, deps, opened, saved, toasts, controller: () => controller, runBind }
}

function makeController(overrides = {}) {
  const toasts = []
  const controller = createSessionPickerController({
    sessions: overrides.sessions ?? sessions,
    truncated: overrides.truncated ?? false,
    loadPreviewText: overrides.loadPreviewText ?? (async id => previews[id] ?? ""),
    openTabIDs: overrides.openTabIDs ?? (() => []),
    now: () => NOW,
    toast: options => toasts.push(options),
  })
  return { controller, toasts }
}

const ids = controller => controller.rows().map(row => row.id)
const marks = controller => Object.fromEntries(controller.rows().map(row => [row.id, row.selected]))
const active = controller => controller.rows().find(row => row.active)?.id

// ---------------------------------------------------------------------------
// Controller: the state machine the dialog renders. These are the regression
// tests for the fixed limitation — exact query and highlight across every
// interaction that used to rebuild (and reset) the search input.
// ---------------------------------------------------------------------------

test("query, highlight, and selection persist across toggle, select-shown, and preview", async () => {
  const { controller } = makeController()
  controller.setQuery("login")
  assert.deepEqual(ids(controller), ["ses_a"])
  assert.equal(controller.query(), "login")
  assert.equal(active(controller), "ses_a")

  controller.selectShown() // ctrl+a respects the active query
  assert.deepEqual(marks(controller), { ses_a: true })
  controller.selectShown() // toggling again removes the shown rows
  assert.deepEqual(controller.selectedIds(), [])

  controller.toggle() // ctrl+t on the highlighted row
  assert.equal(controller.query(), "login", "toggle keeps the exact query")
  assert.equal(active(controller), "ses_a", "toggle keeps the highlight")
  assert.deepEqual(controller.selectedIds(), ["ses_a"])

  controller.togglePreview() // ctrl+r opens the inline preview
  await settle(1)
  assert.equal(controller.previewOpen(), true)
  assert.equal(controller.query(), "login", "preview keeps the exact query")
  assert.equal(active(controller), "ses_a", "preview keeps the highlight")
  assert.deepEqual(controller.selectedIds(), ["ses_a"], "preview keeps the selection")
  controller.closePreview()
  assert.equal(controller.query(), "login")
  assert.deepEqual(controller.selectedIds(), ["ses_a"])
  controller.dispose()
})

test("typed previews become searchable through a reactive cache bump", async () => {
  const { controller } = makeController()
  controller.setQuery("token refresh") // text that only exists inside ses_a's preview
  assert.deepEqual(ids(controller), [])
  controller.setQuery("")
  controller.moveLast() // highlight ses_b (oldest)
  controller.move(-1) // back to ses_a
  controller.togglePreview()
  await settle(1)
  controller.setQuery("token refresh")
  assert.deepEqual(ids(controller), ["ses_a"], "preview text lands in the search haystack once loaded")
  controller.dispose()
})

test("preview loading races: a superseded load never overwrites a newer target", async () => {
  let releaseA
  const gateA = new Promise(resolve => {
    releaseA = resolve
  })
  const { controller } = makeController({
    loadPreviewText: async id => {
      if (id === "ses_a") {
        await gateA
        return "You: stale target"
      }
      return "Agent: current target"
    },
  })
  controller.move(1) // highlight ses_a
  controller.togglePreview()
  controller.move(1) // highlight ses_b while ses_a is still loading
  controller.togglePreview()
  await settle(1)
  assert.equal(controller.previewBody(), "Agent: current target")
  releaseA() // the slow ses_a load resolves after the switch
  await settle(1)
  assert.equal(controller.previewBody(), "Agent: current target", "stale load is discarded")
  assert.match(controller.previewHeader() ?? "", /^Write docs/, "preview stays on ses_b")
  controller.dispose()
})

test("preview failures fall back to the empty-message notice body", async () => {
  const { controller } = makeController({
    loadPreviewText: async () => {
      throw new Error("message sync failed")
    },
  })
  controller.move(1) // ses_a
  controller.togglePreview()
  await settle(1)
  assert.equal(controller.previewLoading(), false)
  assert.equal(controller.previewBody(), "", "the view renders the no-messages notice for an empty body")
  controller.dispose()
})

test("highlight falls back stably when the filter changes under it", () => {
  const { controller } = makeController()
  assert.equal(active(controller), "ses_c", "newest row highlighted by default")
  controller.move(1)
  assert.equal(active(controller), "ses_a")
  controller.setQuery("docs")
  assert.equal(active(controller), "ses_b", "missing highlight lands on the nearest row (index clamped)")
  controller.setQuery("login")
  assert.equal(active(controller), "ses_a")
  controller.setQuery("nope")
  assert.deepEqual(ids(controller), [])
  assert.equal(controller.highlightedId(), "ses_a", "highlight id survives an empty result list")
  controller.setQuery("")
  assert.equal(active(controller), "ses_a", "highlight returns to its row when the filter clears")
  controller.dispose()
})

test("selection keeps insertion order and survives query changes", () => {
  const { controller } = makeController()
  controller.setQuery("docs")
  controller.toggle()
  controller.setQuery("login")
  controller.toggle()
  controller.setQuery("")
  assert.deepEqual(controller.selectedIds(), ["ses_b", "ses_a"], "order follows selection, not listing")
  controller.toggleAt("ses_b")
  assert.deepEqual(controller.selectedIds(), ["ses_a"])
  controller.dispose()
})

test("save with no selection toasts and never issues a request; open reports the highlighted fallback", async () => {
  const { controller, toasts } = makeController()
  controller.saveSet()
  assert.match(toasts[0].message, /Select sessions first/)
  const nextRequest = controller.takeRequest()
  const raced = await Promise.race([nextRequest.then(() => "requested"), settle(5).then(() => "none")])
  assert.equal(raced, "none", "no dialog round-trip for an empty selection")

  controller.open(true)
  assert.deepEqual(await nextRequest, { type: "open", focus: true, fallback: "ses_c" })
  controller.dispose()
})

test("takeRequest/request handshakes resolve live waiters and queue requests made before the wait", async () => {
  const { controller } = makeController()

  // A request issued while nobody is waiting is queued for the next take.
  controller.open(false)
  assert.deepEqual(await controller.takeRequest(), { type: "open", focus: false, fallback: "ses_c" })

  // A take created first is resolved by the next request.
  const pending = controller.takeRequest()
  controller.toggle() // select ses_c
  controller.saveSet()
  assert.deepEqual(await pending, { type: "save" })

  // resetRequests drops both a queued request and any dangling waiter, so a
  // re-shown dialog starts clean instead of resolving with a stale outcome.
  controller.open(false)
  controller.resetRequests()
  const raced = await Promise.race([controller.takeRequest().then(() => "resolved"), settle(5).then(() => "none")])
  assert.equal(raced, "none", "the dropped request never surfaces")
  controller.dispose()
})

test("dispose is idempotent and the controller stays readable after disposal", () => {
  const { controller } = makeController()
  controller.setQuery("login")
  controller.dispose()
  controller.dispose() // must not throw
  assert.equal(controller.query(), "login")
  assert.deepEqual(ids(controller), ["ses_a"])
  controller.move(1) // signal writes after dispose are harmless
  controller.togglePreview()
  controller.closePreview()
  assert.equal(controller.previewOpen(), false)
})

test("rows describe directory, recency, open tabs, and previewed text", async () => {
  const { controller } = makeController({ openTabIDs: () => ["ses_b"] })
  controller.move(1) // highlight ses_a and preview it
  controller.togglePreview()
  await settle(1)
  const byId = Object.fromEntries(controller.rows().map(row => [row.id, row]))
  assert.match(byId.ses_a.description, /\/code\/app · 1m ago/)
  assert.match(byId.ses_a.description, /You: why is login broken\?/)
  assert.match(byId.ses_b.description, /tab open/)
  assert.equal(byId.ses_c.title, "Untitled session")
  assert.match(byId.ses_c.description, /\/code\/app · just now/)
  controller.dispose()
})

test("a truncated discovery notes the cap in the title line", () => {
  const { controller } = makeController({ truncated: true })
  assert.equal(controller.titleLine(), "Open sessions as tabs — 0 selected · newest 3 shown")
  controller.dispose()
})

// ---------------------------------------------------------------------------
// Flow: dialog lifecycle against the fake host surface.
// ---------------------------------------------------------------------------

test("enter toggles and ctrl+o opens the selection in order; escape cancels with nothing opened", async () => {
  const { driver, deps, opened, controller, runBind } = makeDeps()
  const done = runSessionPicker(deps)
  const first = await driver.next()
  assert.equal(first.kind, "show")
  assert.deepEqual(driver.setCalls, [{ size: "large" }], "picker requests a large dialog")

  runBind("down") // highlight ses_a
  runBind("enter") // toggle it
  runBind("down") // highlight ses_b
  runBind("ctrl+t") // toggle it too (footer action path)
  runBind("ctrl+o")
  assert.deepEqual(await done, {
    status: "opened",
    opened: ["ses_a", "ses_b"],
    alreadyOpen: [],
    focused: false,
  })
  assert.deepEqual(opened, [{ ids: ["ses_a", "ses_b"], focus: false }])

  const solo = makeDeps()
  const soloDone = runSessionPicker(solo.deps)
  await solo.driver.next()
  solo.runBind("ctrl+o") // nothing selected: opens the highlighted session
  assert.deepEqual(await soloDone, {
    status: "opened",
    opened: ["ses_c"],
    alreadyOpen: [],
    focused: false,
  })
  assert.equal(solo.driver.currentShow(), undefined, "dialog cleared after open")
})

test("escape cancels the picker without opening tabs", async () => {
  const { driver, deps, opened, runBind } = makeDeps()
  const done = runSessionPicker(deps)
  await driver.next()
  runBind("enter")
  driver.closeShow() // host dialog Escape: onClose fires
  assert.deepEqual(await done, { status: "cancelled" })
  assert.deepEqual(opened, [])
})

test("ctrl+f opens the selection and focuses the last tab", async () => {
  const { driver, deps, opened, runBind } = makeDeps()
  const done = runSessionPicker(deps)
  await driver.next()
  runBind("down")
  runBind("enter") // ses_a
  runBind("down")
  runBind("enter") // ses_b
  runBind("ctrl+f")
  assert.deepEqual(await done, { status: "opened", opened: ["ses_a", "ses_b"], alreadyOpen: [], focused: true })
  assert.deepEqual(opened, [{ ids: ["ses_a", "ses_b"], focus: true }])
})

test("ctrl+o with an empty result list and no selection keeps the dialog up", async () => {
  const { driver, deps, opened, controller, runBind } = makeDeps()
  const done = runSessionPicker(deps)
  await driver.next()
  controller().setQuery("nope") // no rows, no selection
  const showsBefore = driver.shows.length
  runBind("ctrl+o")
  await settle(5)
  assert.equal(driver.shows.length, showsBefore, "no clear-and-reshow flicker")
  assert.ok(driver.currentShow(), "dialog still shown")
  driver.closeShow()
  assert.deepEqual(await done, { status: "cancelled" })
  assert.deepEqual(opened, [])
})

test("partial tab failures are reported as warnings, not successes", async () => {
  const { driver, deps, toasts, runBind } = makeDeps({
    openTabs: async (ids, { focus } = {}) => ({
      opened: ids.slice(0, 1),
      alreadyOpen: [],
      focused: false,
      error: "OpenCode did not retain tab ses_b.",
    }),
  })
  const done = runSessionPicker(deps)
  await driver.next()
  runBind("down")
  runBind("enter")
  runBind("down")
  runBind("enter")
  runBind("ctrl+o")
  const outcome = await done
  assert.equal(outcome.status, "error")
  assert.deepEqual(outcome.opened, ["ses_a"])
  assert.match(toasts.at(-1).message, /did not retain/)
  assert.equal(toasts.at(-1).variant, "warning")
})

test("disabled tabs explain themselves instead of opening a modal", async () => {
  const { driver, deps, toasts } = makeDeps({ tabsEnabled: () => false })
  const outcome = await runSessionPicker(deps)
  assert.deepEqual(outcome, { status: "cancelled" })
  assert.equal(driver.shows.length, 0)
  assert.match(toasts[0].message, /disabled/)
})

test("an empty session list is explained and never opens a modal", async () => {
  const { driver, deps } = makeDeps({ loadSessions: async () => ({ sessions: [] }) })
  const done = runSessionPicker(deps)
  const call = await driver.next()
  assert.equal(call.kind, "alert")
  driver.closeAlert()
  assert.deepEqual(await done, { status: "cancelled" })
})

test("the session list is discovered once at command start and stays a stable snapshot", async () => {
  let available = [sessions[0]]
  let loads = 0
  const { driver, deps, runBind } = makeDeps({
    loadSessions: async () => {
      loads++
      return { sessions: available.slice() }
    },
  })
  const done = runSessionPicker(deps)
  await driver.next()
  runBind("enter")
  available = sessions
  await settle(5)
  assert.equal(loads, 1, "toggling never re-queries the server")
  driver.closeShow()
  assert.deepEqual(await done, { status: "cancelled" })
})

test("saving the selection prompts for a validated name and reports overwrites", async () => {
  const { driver, deps, saved, runBind } = makeDeps({ listWorkspaceNames: async () => ["daily"] })
  const done = runSessionPicker(deps)
  await driver.next()
  runBind("down")
  runBind("enter") // select ses_a
  runBind("ctrl+s")

  const prompt = await driver.next()
  assert.equal(prompt.kind, "prompt")
  driver.answerPrompt("") // invalid: empty after trim
  const invalid = await driver.next()
  assert.equal(invalid.kind, "alert")
  driver.closeAlert()
  const retry = await driver.next()
  assert.equal(retry.kind, "prompt")
  driver.answerPrompt("daily") // existing name -> confirm overwrite
  const confirm = await driver.next()
  assert.equal(confirm.kind, "confirm")
  driver.answerConfirm(false) // choose rename
  const renamed = await driver.next()
  assert.equal(renamed.kind, "prompt")
  driver.answerPrompt("  review  ")

  const reopened = await driver.next()
  assert.equal(reopened.kind, "show", "picker re-shown after the save flow")
  assert.deepEqual(saved, [{ name: "review", ids: ["ses_a"] }])
  driver.closeShow()
  await done
})

test("the selection stays intact and actionable after a save-set round-trip", async () => {
  const { driver, deps, opened, controller, runBind } = makeDeps()
  const done = runSessionPicker(deps)
  await driver.next()
  runBind("down")
  runBind("enter") // ses_a
  controller().setQuery("login") // a query in flight while saving
  runBind("ctrl+s")
  const prompt = await driver.next()
  driver.answerPrompt("review")
  const reopened = await driver.next()
  assert.equal(reopened.kind, "show")

  assert.equal(controller().query(), "login", "query survives the save round-trip")
  runBind("ctrl+o") // still exactly the pre-save selection
  assert.deepEqual(await done, { status: "opened", opened: ["ses_a"], alreadyOpen: [], focused: false })
  assert.deepEqual(opened, [{ ids: ["ses_a"], focus: false }])
})

test("saving without a selection explains how to select and the dialog stays open", async () => {
  const { driver, deps, saved, toasts, runBind } = makeDeps()
  const done = runSessionPicker(deps)
  await driver.next()
  const showsBefore = driver.shows.length
  runBind("ctrl+s")
  await settle(5)
  assert.equal(driver.shows.length, showsBefore, "no re-show needed: the dialog never closed")
  assert.match(toasts[0].message, /Select sessions first/)
  assert.deepEqual(saved, [])
  driver.closeShow()
  await done
})

test("failed saves surface the server error and let the user retry", async () => {
  const { driver, deps, toasts, runBind } = makeDeps({
    saveWorkspace: async () => {
      throw new Error("Cannot save set \"x\": 1 session(s) no longer exist: ses_z.")
    },
  })
  const done = runSessionPicker(deps)
  await driver.next()
  runBind("down")
  runBind("enter")
  runBind("ctrl+s")
  const prompt = await driver.next()
  driver.answerPrompt("x")
  const failure = await driver.next()
  assert.equal(failure.kind, "alert")
  assert.match(failure.options.message, /ses_z/)
  driver.closeAlert()
  const retryPrompt = await driver.next()
  driver.answerPrompt(undefined) // cancel
  const reopened = await driver.next()
  assert.equal(reopened.kind, "show")
  assert.equal(toasts.length, 0)
  driver.closeShow()
  await done
})

test("structured RPC failures render their message, never [object Object]", async () => {
  const stale = {
    _tag: "RpcError",
    type: "rpc.method_not_found",
    message: "Method not found: session-tabs/workspaceSave",
    data: { request: { authorization: "Bearer secret-token" } },
  }
  const { driver, deps, runBind } = makeDeps({ saveWorkspace: async () => { throw stale } })
  const done = runSessionPicker(deps)
  await driver.next()
  runBind("down")
  runBind("enter")
  runBind("ctrl+s")
  const prompt = await driver.next()
  driver.answerPrompt("daily")
  const failure = await driver.next()
  assert.equal(failure.kind, "alert")
  assert.equal(failure.options.message, "Method not found: session-tabs/workspaceSave")
  assert.ok(!failure.options.message.includes("[object Object]"))
  assert.ok(!failure.options.message.includes("secret-token"), "the RpcError data payload is never dumped")
  driver.closeAlert()
  const retryPrompt = await driver.next()
  driver.answerPrompt(undefined)
  const reopened = await driver.next()
  assert.equal(reopened.kind, "show")
  driver.closeShow()
  await done
})

test("openTabs rejections that are plain objects still toast a readable message", async () => {
  const { driver, deps, toasts, runBind } = makeDeps({
    openTabs: async () => {
      throw { _tag: "RpcError", type: "rpc.internal", message: "location not found" }
    },
  })
  const done = runSessionPicker(deps)
  await driver.next()
  runBind("ctrl+o")
  const outcome = await done
  assert.deepEqual(outcome, {
    status: "error",
    message: "location not found",
    opened: [],
    alreadyOpen: [],
    focused: false,
  })
  assert.equal(toasts.at(-1).message, "Open: location not found")
  assert.equal(toasts.at(-1).variant, "error")
})

test("discovery failures that are plain objects render their message", async () => {
  const { driver, deps, toasts } = makeDeps({
    loadSessions: async () => {
      throw { _tag: "RpcError", type: "rpc.timeout", message: "server timed out" }
    },
  })
  const outcome = await runSessionPicker(deps)
  assert.deepEqual(outcome, { status: "error", message: "server timed out" })
  assert.equal(driver.shows.length, 0)
  assert.equal(toasts[0].message, "Could not load sessions from the server: server timed out")
})

test("the picker lists only top-level sessions from the discovery snapshot", async () => {
  // Regression (live hit): subagent sessions are filtered by discovery, not
  // by the picker — the controller renders exactly the snapshot it receives.
  const root = { id: "ses_root", title: "Feature brainstorm", location: { directory: "/code/app" }, time: { updated: NOW - 60_000 } }
  const child = { id: "ses_child", parentID: "ses_root", title: "Subagent research", location: { directory: "/code/app" }, time: { updated: NOW - 1000 } }
  const { driver, deps, controller } = makeDeps({
    loadSessions: async () => discoverSessions({ list: async () => ({ data: [child, root], cursor: { next: null } }) }),
  })
  const done = runSessionPicker(deps)
  await driver.next()
  driver.closeShow()
  await done
  assert.deepEqual(ids(controller()), ["ses_root"], "only the root conversation is offered")
})

// ---------------------------------------------------------------------------
// Keyboard scope: command table shape (the view binds these into the host's
// modal keymap mode; picker-ui.test.tsx asserts the layer registration).
// ---------------------------------------------------------------------------

test("command table maps stable ids to the documented binds", () => {
  const { controller } = makeController()
  const binds = Object.fromEntries(pickerCommands(controller).map(command => [command.bind, command.id]))
  assert.equal(binds["enter"], "local.session-tabs.picker.toggle")
  assert.equal(binds["ctrl+t"], "local.session-tabs.picker.toggle_key")
  assert.equal(binds["ctrl+o"], "local.session-tabs.picker.open")
  assert.equal(binds["ctrl+f"], "local.session-tabs.picker.focus_open")
  assert.equal(binds["ctrl+r"], "local.session-tabs.picker.preview")
  assert.equal(binds["ctrl+a"], "local.session-tabs.picker.select_shown")
  assert.equal(binds["ctrl+s"], "local.session-tabs.picker.save_set")
  assert.equal(binds.escape, "local.session-tabs.picker.back")
  assert.equal(binds.up, "local.session-tabs.picker.prev")
  assert.equal(binds.down, "local.session-tabs.picker.next")
  controller.dispose()
})

test("escape returns false when no preview is open so the host dialog layer closes the picker", async () => {
  const { driver, deps, controller, runBind } = makeDeps()
  const done = runSessionPicker(deps)
  await driver.next()
  assert.equal(runBind("escape"), false, "false means not handled: dispatch continues to the host layer")
  assert.ok(driver.currentShow(), "the picker dialog itself is still up")
  driver.closeShow()
  assert.deepEqual(await done, { status: "cancelled" })
})

test("escape consumes the key while a preview is open, closing only the preview", async () => {
  const { driver, deps, controller, runBind } = makeDeps()
  const done = runSessionPicker(deps)
  await driver.next()
  runBind("ctrl+r")
  await settle(1)
  assert.equal(runBind("escape"), undefined, "handled: the host layer must not also run")
  assert.ok(driver.currentShow(), "the picker survives escape-with-preview")
  assert.equal(runBind("escape"), false, "next escape falls through to close the picker")
  driver.closeShow()
  await done
})
