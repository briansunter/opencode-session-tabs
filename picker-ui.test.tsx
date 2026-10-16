// Real-UI regression tests for the session picker: they mount the actual
// dialog JSX through @opentui/solid's test renderer, type into the real
// search input, run the same keymap commands the host keymap would, and
// assert on rendered frames. These lock in the fix for the old limitation
// where dialog.select rebuilt (and cleared) its search input after every
// toggle, preview, or save-set round-trip.
import test from "node:test"
import assert from "node:assert/strict"
import { testRender } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import type { JSX } from "@opentui/solid"
import { runSessionPicker } from "./picker.tsx"
import { fakeDialog } from "./dialog-driver.js"

type TestRendererSetup = Awaited<ReturnType<typeof testRender>>

const NOW = 1_700_000_000_000

const sessions = [
  { id: "ses_a", title: "Fix login bug", location: { directory: "/code/app" }, time: { updated: NOW - 60_000 } },
  { id: "ses_b", title: "Write docs", location: { directory: "/code/docs" }, time: { updated: NOW - 5 * 3_600_000 } },
  { id: "ses_c", title: "Refactor auth", location: { directory: "/code/app" }, time: { updated: NOW - 2 } },
]

const previews: Record<string, string> = { ses_a: "You: why is login broken?\nAgent: token refresh expired" }

const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

type Harness = {
  driver: ReturnType<typeof fakeDialog>
  layers: Array<{ mode?: string; commands: Array<{ id: string; bind: string; run: () => unknown }> }>
  opened: Array<{ ids: string[]; focus: boolean }>
  saved: Array<{ name: string; ids: string[] }>
  toasts: Array<{ message: string; variant?: string }>
  done: Promise<{ status: string }>
  setup: TestRendererSetup
  runBind: (bind: string) => unknown
  syncRender: () => void
  frame: () => string
}

async function startPicker(overrides: Record<string, unknown> = {}, size = { width: 100, height: 34 }): Promise<Harness> {
  const driver = fakeDialog()
  const layers: Harness["layers"] = []
  const opened: Harness["opened"] = []
  const saved: Harness["saved"] = []
  const toasts: Harness["toasts"] = []
  const deps = {
    dialog: driver.dialog,
    layer: (factory: () => { mode?: string; commands: unknown[] }) => {
      layers.push(factory() as never)
    },
    shortcut: () => undefined,
    loadSessions: async () => ({ sessions: sessions.slice() }),
    openTabs: async (ids: string[], { focus }: { focus?: boolean } = {}) => {
      opened.push({ ids, focus: focus === true })
      return { opened: ids, alreadyOpen: [], focused: focus === true }
    },
    loadPreviewText: async (id: string) => previews[id] ?? "",
    saveWorkspace: async (name: string, ids: string[]) => {
      saved.push({ name, ids })
      return { name, sessionIDs: ids, createdAt: NOW, updatedAt: NOW }
    },
    listWorkspaceNames: async () => [] as string[],
    toast: (options: { message: string; variant?: string }) => toasts.push(options),
    openTabIDs: () => [] as string[],
    formatPath: (value: string) => value,
    now: () => NOW,
    tabsEnabled: () => true,
    ...overrides,
  }
  const done = runSessionPicker(deps as never)

  // Remount bridge: the flow hands its render function to dialog.show; the
  // test renderer displays whatever the latest show carries. A keyed Show
  // re-runs (and disposes the previous child) whenever the version changes —
  // the same replace-and-remount the host DialogProvider performs.
  let currentRender: (() => JSX.Element) | undefined
  const [version, bumpVersion] = createSignal(0)
  const syncRender = () => {
    currentRender = driver.currentShow()?.render as (() => JSX.Element) | undefined
    bumpVersion(value => value + 1)
  }
  const setup = await testRender(
    () => (
      <Show when={version()} keyed fallback={<box />}>
        {/* The parameter matters: Solid only re-invokes children callbacks
            that accept the keyed value, so only these remount on every
            truthy->truthy change (a zero-arg closure would run once). */}
        {(_version: number) => currentRender?.() ?? <box />}
      </Show>
    ),
    size,
  )
  await driver.next() // the picker's first show
  syncRender()
  await settle(5) // the input focuses on a timeout, like the host dialogs
  await setup.flush()

  const runBind = (bind: string) => {
    for (let index = layers.length - 1; index >= 0; index--) {
      const command = layers[index].commands.find(entry => entry.bind === bind)
      if (command) return command.run()
    }
    throw new Error(`no command bound to ${bind}`)
  }
  return { driver, layers, opened, saved, toasts, done, setup, runBind, syncRender, frame: () => setup.captureCharFrame() }
}

test("shortcut footer wraps without clipping at normal dialog widths", async () => {
  const picker = await startPicker({}, { width: 80, height: 34 })
  try {
    const frame = picker.frame()
    for (const label of ["toggle enter", "open ctrl+o", "focus ctrl+f", "preview ctrl+r", "select shown ctrl+a", "save set ctrl+s"]) {
      assert.ok(frame.includes(label), `footer displays ${label}`)
    }
  } finally {
    picker.driver.closeShow()
    await picker.done
    await picker.setup.dispose()
  }
})

test("typing filters the live list and the query stays visible in the input", async () => {
  const picker = await startPicker()
  try {
    const before = picker.frame()
    assert.match(before, /Fix login bug/)
    assert.match(before, /Write docs/)

    await picker.setup.mockInput.typeText("login", 0)
    await picker.setup.flush()
    const filtered = picker.frame()
    assert.match(filtered, /login/, "the typed query is visible in the search field")
    assert.match(filtered, /Fix login bug/, "the matching row is shown")
    assert.ok(!filtered.includes("Write docs"), "non-matching rows are filtered out")

    // Editing the query mid-string still works: the input is never rewritten.
    for (let index = 0; index < 5; index++) await picker.setup.mockInput.pressKey("\b")
    await picker.setup.mockInput.typeText("docs", 0)
    await picker.setup.flush()
    assert.match(picker.frame(), /Write docs/, "backspacing and retyping refilters live")
  } finally {
    picker.driver.closeShow()
    await picker.done
    await picker.setup.dispose()
  }
})

test("ctrl+t toggles without losing the query: checkmark and search text coexist", async () => {
  const picker = await startPicker()
  try {
    await picker.setup.mockInput.typeText("login", 0)
    await picker.setup.flush()

    picker.runBind("ctrl+t")
    await picker.setup.flush()
    const afterToggle = picker.frame()
    assert.match(afterToggle, /login/, "the exact query survives the toggle")
    assert.match(afterToggle, /✓\s*Fix login bug/, "the selected row shows its checkmark")
    assert.ok(!afterToggle.includes("Refactor auth"), "filter still applied after the toggle")

    // The selection stays actionable: open sends exactly what was toggled.
    picker.runBind("ctrl+o")
    const outcome = await picker.done
    assert.equal(outcome.status, "opened")
    assert.deepEqual(picker.opened, [{ ids: ["ses_a"], focus: false }])
  } finally {
    await picker.setup.dispose()
  }
})

test("enter toggles the highlighted row through the same modal-layer path", async () => {
  const picker = await startPicker()
  try {
    picker.runBind("down") // highlight ses_a
    picker.runBind("enter")
    await picker.setup.flush()
    assert.match(picker.frame(), /✓\s*Fix login bug/)
    picker.runBind("enter")
    await picker.setup.flush()
    assert.ok(!/✓\s*Fix login bug/.test(picker.frame()), "enter toggles off again")
    picker.driver.closeShow()
    assert.deepEqual(await picker.done, { status: "cancelled" })
  } finally {
    await picker.setup.dispose()
  }
})

test("ctrl+a selects every shown row without losing the query, and toggles off again", async () => {
  const picker = await startPicker()
  try {
    await picker.setup.mockInput.typeText("app", 0) // matches ses_a + ses_c by directory
    await picker.setup.flush()
    assert.ok(!picker.frame().includes("Write docs"), "only /code/app rows are shown")

    picker.runBind("ctrl+a") // select shown
    await picker.setup.flush()
    const selected = picker.frame()
    assert.match(selected, /✓\s*Fix login bug/)
    assert.match(selected, /✓\s*Refactor auth/)
    assert.match(selected, /app/, "the query survives select-shown")
    assert.ok(!selected.includes("Write docs"), "select-shown does not clear the filter")

    picker.runBind("ctrl+a") // toggle the shown selection off
    await picker.setup.flush()
    const cleared = picker.frame()
    assert.ok(!/✓\s*Fix login bug/.test(cleared), "select-shown again deselects the shown rows")
    assert.match(cleared, /app/, "the query survives deselecting everything shown")

    picker.driver.closeShow()
    assert.deepEqual(await picker.done, { status: "cancelled" })
  } finally {
    await picker.setup.dispose()
  }
})

test("ctrl+r opens an inline preview; escape closes the preview first, then the picker", async () => {
  const picker = await startPicker()
  try {
    await picker.setup.mockInput.typeText("login", 0)
    await picker.setup.flush()
    picker.runBind("down") // ses_a is the only match; stay on it
    picker.runBind("ctrl+r")
    await settle(5)
    await picker.setup.flush()

    const preview = picker.frame()
    assert.match(preview, /why is login broken/, "the preview body renders inline")
    assert.match(preview, /token refresh expired/)
    assert.match(preview, /login/, "the query survives opening the preview")

    assert.equal(picker.runBind("escape"), undefined, "escape with a preview open is consumed")
    await picker.setup.flush()
    const closed = picker.frame()
    assert.ok(!/Fix login bug — \/code\/app \(1m ago\)/.test(closed), "the preview header pane is gone")
    assert.match(closed, /›\s+Fix login bug/, "the list is back")
    assert.match(closed, /login/, "the query survives closing the preview")
    assert.ok(!closed.includes("Write docs"), "the filter is still applied after closing the preview")

    // The selection made before previewing is still actionable after the close.
    picker.runBind("ctrl+t")
    await picker.setup.flush()
    assert.match(picker.frame(), /✓\s*Fix login bug/)

    assert.equal(picker.runBind("escape"), false, "the next escape falls through to the host")
    picker.driver.closeShow() // the host dialog layer closes the picker
    assert.deepEqual(await picker.done, { status: "cancelled" })
  } finally {
    await picker.setup.dispose()
  }
})

test("a save-set round-trip remounts the dialog with query, selection, and highlight intact", async () => {
  const picker = await startPicker()
  try {
    await picker.setup.mockInput.typeText("login", 0)
    await picker.setup.flush()
    picker.runBind("ctrl+t") // select ses_a with the query active
    await picker.setup.flush()
    const layersBefore = picker.layers.length

    picker.runBind("ctrl+s")
    const prompt = await picker.driver.next()
    assert.equal(prompt.kind, "prompt")
    picker.driver.answerPrompt("review")
    const reopened = await picker.driver.next()
    assert.equal(reopened.kind, "show", "the picker is re-shown after the nested prompt")
    assert.deepEqual(picker.saved, [{ name: "review", ids: ["ses_a"] }])

    picker.syncRender() // mount the re-shown dialog (the old one was replaced)
    await settle(5)
    await picker.setup.flush()

    const resumed = picker.frame()
    assert.match(resumed, /login/, "the exact query is restored in the input after the remount")
    assert.match(resumed, /✓\s*Fix login bug/, "the selection is restored")
    // Strong proof the query survived the remount and not just its text: with
    // an empty input every row would render, so the absence of the
    // non-matching rows means the filter is still applied.
    assert.ok(!resumed.includes("Write docs"), "non-matching rows stay filtered out after the remount")
    assert.ok(!resumed.includes("Refactor auth"), "non-matching rows stay filtered out after the remount")
    assert.ok(picker.layers.length > layersBefore, "the remounted dialog re-registered its keymap layer")

    picker.runBind("ctrl+o")
    const outcome = await picker.done
    assert.equal(outcome.status, "opened")
    assert.deepEqual(picker.opened, [{ ids: ["ses_a"], focus: false }], "the pre-save selection opens")
  } finally {
    await picker.setup.dispose()
  }
})

test("the dialog registers its bindings in the host modal mode and never in the palette", async () => {
  const picker = await startPicker()
  try {
    const layer = picker.layers.at(-1)!
    assert.equal(layer.mode, "modal", "dialog keys live in the host's modal scope only")
    const binds = layer.commands.map(command => command.bind)
    for (const bind of ["up", "down", "enter", "ctrl+t", "ctrl+o", "ctrl+f", "ctrl+r", "ctrl+a", "ctrl+s", "escape"]) {
      assert.ok(binds.includes(bind), `${bind} is bound`)
    }
    assert.ok(layer.commands.every(command => !("palette" in command) || (command as { palette?: boolean }).palette !== true))
    picker.driver.closeShow()
    await picker.done
  } finally {
    await picker.setup.dispose()
  }
})
