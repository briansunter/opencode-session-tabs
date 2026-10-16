import test from "node:test"
import assert from "node:assert/strict"
import { runWorkspaceManager } from "./core.js"
import { fakeDialog } from "./dialog-driver.js"

const NOW = 1_700_000_000_000
const sets = [
  { name: "review", sessionIDs: ["ses_a", "ses_gone"], createdAt: NOW - 5000, updatedAt: NOW - 1000 },
  { name: "docs", sessionIDs: ["ses_b"], createdAt: NOW - 9000, updatedAt: NOW - 8000 },
]
const existing = ["ses_a", "ses_b"]
const titles = { ses_a: "Fix login", ses_b: "Write docs", ses_gone: "Gone" }

function makeDeps(overrides = {}) {
  const driver = fakeDialog()
  const opened = []
  const saved = []
  const removed = []
  const toasts = []
  const deps = {
    dialog: driver.dialog,
    toast: options => toasts.push(options),
    listWorkspaces: async () => ({ workspaces: sets }),
    saveWorkspace: async (name, ids) => {
      saved.push({ name, ids })
      return { name, sessionIDs: ids, createdAt: NOW, updatedAt: NOW }
    },
    removeWorkspace: async name => {
      removed.push(name)
      return { removed: true }
    },
    getSession: async id => {
      if (!existing.includes(id)) throw new Error("not found")
    },
    sessionTitle: id => titles[id],
    openTabs: async (ids, { focus } = {}) => {
      opened.push({ ids, focus })
      return { opened: ids, alreadyOpen: [], focused: focus === true }
    },
    openTabIDs: () => [],
    now: () => NOW,
    tabsEnabled: () => true,
    ...overrides,
  }
  return { driver, deps, opened, saved, removed, toasts }
}

test("Enter opens a clean set in background tabs with a descriptive list", async () => {
  const { driver, deps, opened } = makeDeps()
  const done = runWorkspaceManager(deps)
  const select = await driver.next()
  assert.deepEqual(select.options.options.map(option => option.value), ["review", "docs"])
  assert.match(select.options.options[0].description, /2 session\(s\) · updated just now · Fix login, Gone/)
  driver.submit("docs")
  assert.deepEqual(await done, {
    status: "opened",
    opened: ["ses_b"],
    alreadyOpen: [],
    focused: false,
  })
  assert.deepEqual(opened, [{ ids: ["ses_b"], focus: false }])
})

test("stale sessions are skipped only after explicit confirmation", async () => {
  const { driver, deps, opened } = makeDeps()
  const done = runWorkspaceManager(deps)
  await driver.next()
  driver.submit("review")
  const confirm = await driver.next()
  assert.equal(confirm.kind, "confirm")
  assert.match(confirm.options.message, /ses_gone/)
  assert.match(confirm.options.message, /Open the remaining 1\?/)
  driver.answerConfirm(true)
  const outcome = await done
  assert.equal(outcome.status, "opened")
  assert.deepEqual(opened, [{ ids: ["ses_a"], focus: false }])
})

test("declining the stale notice opens nothing", async () => {
  const { driver, deps, opened } = makeDeps()
  const done = runWorkspaceManager(deps)
  await driver.next()
  driver.submit("review")
  const confirm = await driver.next()
  driver.answerConfirm(false)
  assert.deepEqual(await done, { status: "cancelled" })
  assert.deepEqual(opened, [])
})

test("an entirely missing set offers prune or delete instead of opening", async () => {
  const { driver, deps, opened } = makeDeps({
    listWorkspaces: async () => ({ workspaces: [{ name: "ghosts", sessionIDs: ["ses_gone"], createdAt: 1, updatedAt: 2 }] }),
  })
  const done = runWorkspaceManager(deps)
  await driver.next()
  driver.submit("ghosts")
  const alert = await driver.next()
  assert.equal(alert.kind, "alert")
  assert.match(alert.options.message, /Every saved session no longer exists/)
  driver.closeAlert()
  assert.deepEqual(await done, { status: "cancelled" })
  assert.deepEqual(opened, [])
})

test("ctrl+f opens a set and focuses its last tab", async () => {
  const { driver, deps, opened } = makeDeps()
  const done = runWorkspaceManager(deps)
  await driver.next()
  driver.trigger("ctrl+f", "docs")
  assert.deepEqual(await done, {
    status: "opened",
    opened: ["ses_b"],
    alreadyOpen: [],
    focused: true,
  })
  assert.deepEqual(opened, [{ ids: ["ses_b"], focus: true }])
})

test("pruning rewrites the set without its missing sessions", async () => {
  const { driver, deps, saved, toasts } = makeDeps()
  const done = runWorkspaceManager(deps)
  await driver.next()
  driver.trigger("ctrl+r", "review")
  const confirm = await driver.next()
  assert.match(confirm.options.message, /Remove 1 missing session\(s\).*keeping 1/)
  driver.answerConfirm(true)
  const reopened = await driver.next()
  assert.equal(reopened.kind, "select")
  assert.deepEqual(saved, [{ name: "review", ids: ["ses_a"] }])
  assert.match(toasts.at(-1).message, /1 session\(s\) remain/)
  driver.escape()
  await done
})

test("pruning a fully stale set deletes it after confirmation", async () => {
  const { driver, deps, removed, saved } = makeDeps({
    listWorkspaces: async () => ({ workspaces: [{ name: "ghosts", sessionIDs: ["ses_gone"], createdAt: 1, updatedAt: 2 }] }),
  })
  const done = runWorkspaceManager(deps)
  await driver.next()
  driver.trigger("ctrl+r", "ghosts")
  const confirm = await driver.next()
  assert.match(confirm.options.title, /Empty set/)
  driver.answerConfirm(true)
  const reopened = await driver.next()
  assert.equal(reopened.kind, "select")
  assert.deepEqual(removed, ["ghosts"])
  assert.deepEqual(saved, [])
  driver.escape()
  await done
})

test("pruning a clean set is a no-op and keeps the modal open", async () => {
  const { driver, deps, saved, toasts } = makeDeps()
  const done = runWorkspaceManager(deps)
  await driver.next()
  driver.trigger("ctrl+r", "docs")
  const reopened = await driver.next()
  assert.equal(reopened.kind, "select")
  assert.deepEqual(saved, [])
  assert.match(toasts[0].message, /no stale sessions/)
  driver.escape()
  await done
})

test("deleting asks first and supports cancelling", async () => {
  const { driver, deps, removed } = makeDeps()
  const done = runWorkspaceManager(deps)
  await driver.next()
  driver.trigger("ctrl+d", "docs")
  const confirm = await driver.next()
  driver.answerConfirm(false)
  const afterCancel = await driver.next()
  assert.equal(afterCancel.kind, "select")
  assert.deepEqual(removed, [])
  driver.trigger("ctrl+d", "docs")
  const confirmAgain = await driver.next()
  assert.match(confirmAgain.options.message, /Sessions and open tabs are not affected/)
  driver.answerConfirm(true)
  await driver.next()
  assert.deepEqual(removed, ["docs"])
  driver.escape()
  await done
})

test("saving open tabs stores the current tab order, deduplicated", async () => {
  const { driver, deps, saved } = makeDeps({ openTabIDs: () => ["ses_a", "ses_b", "ses_a"] })
  const done = runWorkspaceManager(deps)
  await driver.next()
  driver.trigger("ctrl+s", "review")
  const prompt = await driver.next()
  assert.equal(prompt.kind, "prompt")
  driver.answerPrompt("today")
  const reopened = await driver.next()
  assert.equal(reopened.kind, "select")
  assert.deepEqual(saved, [{ name: "today", ids: ["ses_a", "ses_b"] }])
  driver.escape()
  await done
})

test("with no saved sets, the manager offers to save the open tabs directly", async () => {
  const { driver, deps, saved, toasts } = makeDeps({
    listWorkspaces: async () => ({ workspaces: [] }),
    openTabIDs: () => ["ses_b"],
  })
  const done = runWorkspaceManager(deps)
  const alert = await driver.next()
  assert.match(alert.options.message, /No saved session sets yet/)
  driver.closeAlert()
  const prompt = await driver.next()
  driver.answerPrompt("first set")
  assert.deepEqual(await done, { status: "saved", name: "first set" })
  assert.deepEqual(saved, [{ name: "first set", ids: ["ses_b"] }])
  assert.equal(toasts.length, 1)
})

test("save-tabs with nothing open explains itself and cancels", async () => {
  const { driver, deps, saved, toasts } = makeDeps({
    listWorkspaces: async () => ({ workspaces: [] }),
    openTabIDs: () => [],
  })
  const done = runWorkspaceManager(deps)
  const alert = await driver.next()
  driver.closeAlert()
  assert.deepEqual(await done, { status: "cancelled" })
  assert.deepEqual(saved, [])
  assert.match(toasts[0].message, /No open tabs to save/)
})

test("a failed listing reports an error instead of an empty modal", async () => {
  const { driver, deps, toasts } = makeDeps({
    listWorkspaces: async () => {
      throw new Error("rpc unavailable")
    },
  })
  const outcome = await runWorkspaceManager(deps)
  assert.equal(outcome.status, "error")
  assert.match(outcome.message, /rpc unavailable/)
  assert.match(toasts[0].message, /Could not load saved sets/)
  assert.equal(driver.selects.length, 0)
})

test("a saved set containing a child session fails with the parent pointer and is not mutated", async () => {
  // Regression (live hit): a set saved with a subagent session ID opened the
  // parent's tab and then reported "OpenCode did not retain" the child. The
  // set must fail with guidance instead of opening anything or being
  // silently rewritten to the parent ID.
  const childError = new Error(
    "ses_child is a child session. Open parent ses_parent instead; child sessions appear inside parent. No tabs were opened.",
  )
  const { driver, deps, opened, saved, removed, toasts } = makeDeps({
    listWorkspaces: async () => ({
      workspaces: [{ name: "mixed", sessionIDs: ["ses_a", "ses_child"], createdAt: NOW - 5000, updatedAt: NOW - 1000 }],
    }),
    // The child session exists on the server, so it passes the stale check;
    // the failure must come from the tab-opening preflight, not the resolver.
    getSession: async () => {},
    openTabs: async () => {
      throw childError
    },
  })
  const done = runWorkspaceManager(deps)
  await driver.next()
  driver.submit("mixed")
  const outcome = await done
  assert.equal(outcome.status, "error")
  assert.match(outcome.message, /Open parent ses_parent instead; child sessions appear inside parent/)
  assert.match(toasts.at(-1).message, /Set "mixed": ses_child is a child session/)
  assert.equal(toasts.at(-1).variant, "error")
  assert.deepEqual(opened, [], "no tabs were opened")
  assert.deepEqual(saved, [], "the saved set was not rewritten or pruned")
  assert.deepEqual(removed, [])
})

test("a stale server's structured RPC failure renders its message, never [object Object]", async () => {
  // Regression: workspaceList rejecting with a plain RpcError object used to
  // toast "Could not load saved sets: [object Object]".
  const stale = { _tag: "RpcError", type: "rpc.method_not_found", message: "Method not found: session-tabs/workspaceList" }
  const { driver, deps, toasts } = makeDeps({
    listWorkspaces: async () => {
      throw stale
    },
  })
  const outcome = await runWorkspaceManager(deps)
  assert.equal(outcome.status, "error")
  assert.equal(outcome.message, "Method not found: session-tabs/workspaceList")
  assert.equal(toasts[0].message, "Could not load saved sets: Method not found: session-tabs/workspaceList")
  assert.ok(!toasts[0].message.includes("[object Object]"))
  assert.equal(driver.selects.length, 0)
})

test("prune/delete/save failures that are plain objects still toast readable messages", async () => {
  const { driver, deps, toasts } = makeDeps({
    removeWorkspace: async () => {
      throw { _tag: "RpcError", message: "storage locked" }
    },
    saveWorkspace: async () => {
      throw { _tag: "RpcError", message: "storage locked" }
    },
  })
  const done = runWorkspaceManager(deps)
  await driver.next()
  driver.trigger("ctrl+d", "docs")
  const confirm = await driver.next()
  driver.answerConfirm(true)
  await driver.next()
  assert.equal(toasts.at(-1).message, "storage locked")
  assert.equal(toasts.at(-1).variant, "error")
  assert.ok(!toasts.at(-1).message.includes("[object Object]"))
  driver.trigger("ctrl+r", "review")
  const pruneConfirm = await driver.next()
  driver.answerConfirm(true)
  await driver.next()
  assert.equal(toasts.at(-1).message, "storage locked")
  driver.escape()
  await done
})

test("Escape cancels the manager without opening anything", async () => {
  const { driver, deps, opened } = makeDeps()
  const done = runWorkspaceManager(deps)
  await driver.next()
  driver.escape()
  assert.deepEqual(await done, { status: "cancelled" })
  assert.deepEqual(opened, [])
})

test("disabled tabs explain themselves instead of opening a modal", async () => {
  const { driver, deps, toasts } = makeDeps({ tabsEnabled: () => false })
  const outcome = await runWorkspaceManager(deps)
  assert.deepEqual(outcome, { status: "cancelled" })
  assert.equal(driver.selects.length, 0)
  assert.match(toasts[0].message, /disabled/)
})
