// Session picker built on the documented custom-JSX dialog API
// (`context.ui.dialog.show`, OpenCode 2.0 docs → Build plugins → CLI) rather
// than the promise-based `dialog.select`. `dialog.select` rebuilds its search
// input every time an action clears and re-shows the dialog (toggle, preview,
// select-shown, save-set), so the query was lost after every keystroke-level
// interaction. Here the picker's Solid state lives in a controller created
// outside the dialog component, and the dialog JSX only reads it reactively:
// query, filtered rows, highlight, selection, and preview all survive footer
// actions, nested host dialogs (save set), and dialog re-shows.
//
// Keyboard scope: the host pushes its exclusive "modal" keymap mode while any
// dialog is shown, and the view registers its bindings in a `mode: "modal"`
// layer created inside the dialog component. The layer is disposed when the
// dialog JSX unmounts, so bindings never leak to the background or into the
// nested prompt/confirm dialogs. Escape is bound last-wins: it closes an open
// preview itself and otherwise returns false ("not handled"), letting the
// host's own dialog layer close the picker.
import { CliRenderEvents, TextAttributes, type InputRenderable, type ScrollBoxRenderable } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import type {
  DialogAlertOptions,
  DialogConfirmOptions,
  DialogPromptOptions,
  KeymapLayer,
} from "@opencode/plugin/tui/context"
import { batch, createEffect, createMemo, createRoot, createSignal, For, Show, untrack } from "solid-js"
import {
  createPreviewLoader,
  errorMessage,
  filterSessions,
  promptAndSaveWorkspace,
  runOpenTabs,
  singleLine,
  summarizeSessions,
} from "./core.js"

// ---------------------------------------------------------------------------
// Controller: reactive picker state without any rendering. Created once per
// picker invocation, outside the dialog component, so nothing here resets
// when the dialog is replaced, closed, or re-shown.
// ---------------------------------------------------------------------------

export type PickerRequest =
  | { readonly type: "open"; readonly focus: boolean; readonly fallback: string | undefined }
  | { readonly type: "save" }

export type PickerRow = {
  readonly id: string
  readonly title: string
  readonly directory: string
  readonly updated: string
  readonly open: boolean
  readonly preview: string
  readonly description: string
  readonly selected: boolean
  readonly active: boolean
}

export type PickerControllerOptions = {
  readonly sessions: readonly Record<string, unknown>[]
  readonly truncated: boolean
  readonly loadPreviewText: (sessionID: string) => Promise<string>
  readonly openTabIDs?: () => readonly string[]
  readonly formatPath?: (value: string) => string
  readonly now?: () => number
  readonly toast?: (options: { message: string; variant?: "info" | "success" | "warning" | "error" }) => void
}

export type PickerController = {
  // Reactive state read by the view (and tests).
  query(): string
  setQuery(value: string): void
  titleLine(): string
  rows(): readonly PickerRow[]
  highlightedId(): string | undefined
  selectedIds(): readonly string[]
  selectedCount(): number
  truncated(): boolean
  // Inline preview state.
  previewOpen(): boolean
  previewLoading(): boolean
  previewBody(): string | undefined
  previewHeader(): string | undefined
  togglePreview(): void
  closePreview(): void
  // Commands bound to keys (and mouse) by the view.
  move(delta: number): void
  moveFirst(): void
  moveLast(): void
  toggle(): void
  toggleAt(id: string): void
  selectShown(): void
  open(focus: boolean): void
  saveSet(): void
  // Flow plumbing: footer actions that need the flow's attention resolve the
  // current request promise; everything else mutates signals in place.
  takeRequest(): Promise<PickerRequest>
  resetRequests(): void
  dispose(): void
}

// The summary shape produced by core.js summarizeSessions (JS module; typed
// structurally here for the reactive memos).
type Summary = { id: string; title: string; directory: string; updated: string; open?: boolean; preview?: string }

export function createSessionPickerController(options: PickerControllerOptions): PickerController {
  let disposeRoot: (() => void) | undefined
  const controller = createRoot(dispose => {
    disposeRoot = dispose
    const sessions = options.sessions
    const truncated = options.truncated === true
    const loadPreviewText = options.loadPreviewText
    const openTabIDs = options.openTabIDs ?? (() => [])
    const formatPath = options.formatPath ?? ((value: string) => value)
    const now = options.now ?? (() => Date.now())
    const toast = options.toast ?? (() => {})
    const previews = createPreviewLoader({ load: loadPreviewText })

    const [query, setQuerySignal] = createSignal("")
    const [highlight, setHighlight] = createSignal<string | undefined>(undefined)
    const [selected, setSelected] = createSignal<readonly string[]>([])
    const [previewId, setPreviewId] = createSignal<string | undefined>(undefined)
    const [previewBody, setPreviewBody] = createSignal<string | undefined>(undefined)
    const [previewLoading, setPreviewLoading] = createSignal(false)
    // Bumped when a preview load fills the loader cache so search, which also
    // matches previewed text, re-runs for the newly searchable rows.
    const [previewVersion, setPreviewVersion] = createSignal(0)

    const summaries = createMemo<Summary[]>(() => {
      previewVersion()
      const list = summarizeSessions(sessions, {
        now: now(),
        openIDs: openTabIDs() as string[],
        formatPath,
      }) as Summary[]
      for (const summary of list) {
        const cached = previews.peek(summary.id)
        if (cached !== undefined) summary.preview = cached
      }
      return list
    })

    const selectedSet = createMemo(() => new Set(selected()))
    const lastHighlightIndex = { value: 0 }

    const rows = createMemo<readonly PickerRow[]>(() => {
      const active = highlight()
      const chosen = selectedSet()
      return filterSessions(query(), summaries()).map(summary => ({
        id: summary.id,
        title: summary.title,
        directory: summary.directory,
        updated: summary.updated ?? "",
        open: summary.open === true,
        preview: typeof summary.preview === "string" ? summary.preview : "",
        description: [
          summary.directory || "unknown directory",
          summary.updated,
          summary.open ? "tab open" : "",
          summary.preview ? singleLine(summary.preview, 64) : "",
        ]
          .filter(Boolean)
          .join(" · "),
        selected: chosen.has(summary.id),
        active: summary.id === active,
      }))
    })

    // Stable highlight fallback: when the filtered rows change and the
    // highlighted row disappears, keep the nearest position (its previous
    // index clamped into the new list) instead of jumping unpredictably.
    createEffect(() => {
      const current = rows()
      untrack(() => {
        const wanted = highlight()
        if (current.length === 0) return
        if (wanted !== undefined && current.some(row => row.id === wanted)) return
        setHighlight(current[Math.min(lastHighlightIndex.value, current.length - 1)].id)
      })
    })
    createEffect(() => {
      const index = rows().findIndex(row => row.id === highlight())
      if (index >= 0) lastHighlightIndex.value = index
    })

    const highlightedRow = () => rows().find(row => row.active)

    function moveToIndex(index: number) {
      const current = rows()
      if (!current.length) return
      const clamped = Math.max(0, Math.min(index, current.length - 1))
      lastHighlightIndex.value = clamped
      setHighlight(current[clamped].id)
    }

    function move(delta: number) {
      const current = rows()
      if (!current.length) return
      const index = current.findIndex(row => row.active)
      const base = index < 0 ? 0 : index + delta
      const next = ((base % current.length) + current.length) % current.length
      lastHighlightIndex.value = next
      setHighlight(current[next].id)
    }

    function toggleAt(id: string) {
      const current = selected()
      setSelected(current.includes(id) ? current.filter(entry => entry !== id) : [...current, id])
    }

    function toggle() {
      const row = highlightedRow()
      if (row) toggleAt(row.id)
    }

    function selectShown() {
      const shown = rows().map(row => row.id)
      if (!shown.length) return
      const chosen = selectedSet()
      if (shown.every(id => chosen.has(id))) {
        const remove = new Set(shown)
        setSelected(selected().filter(id => !remove.has(id)))
      } else {
        setSelected([...new Set([...selected(), ...shown])])
      }
    }

    function closePreview() {
      batch(() => {
        setPreviewId(undefined)
        setPreviewBody(undefined)
        setPreviewLoading(false)
      })
    }

    async function openPreview(id: string) {
      batch(() => {
        setPreviewId(id)
        setPreviewBody(undefined)
        setPreviewLoading(true)
      })
      const text = await previews.load(id)
      // Newest-wins: a newer preview request, a close, or disposal (null from
      // the loader's generation guard) supersedes this load.
      if (untrack(previewId) !== id || text === null) return
      batch(() => {
        setPreviewBody(text)
        setPreviewLoading(false)
      })
      if (previews.peek(id) !== undefined) setPreviewVersion(version => version + 1)
    }

    function togglePreview() {
      const row = highlightedRow()
      if (!row) return
      if (untrack(previewId) === row.id) closePreview()
      else void openPreview(row.id)
    }

    let queued: PickerRequest | undefined
    let waiter: ((request: PickerRequest) => void) | undefined

    function request(value: PickerRequest) {
      if (waiter) {
        const resolve = waiter
        waiter = undefined
        resolve(value)
      } else {
        queued = value
      }
    }

    function takeRequest() {
      if (queued !== undefined) {
        const value = queued
        queued = undefined
        return Promise.resolve(value)
      }
      return new Promise<PickerRequest>(resolve => {
        waiter = resolve
      })
    }

    function resetRequests() {
      queued = undefined
      waiter = undefined
    }

    function open(focus: boolean) {
      request({ type: "open", focus, fallback: highlightedRow()?.id })
    }

    function saveSet() {
      if (!selected().length) {
        toast({ message: "Select sessions first: Enter or ctrl+t toggles selection.", variant: "warning" })
        return
      }
      request({ type: "save" })
    }

    function titleLine() {
      return `Open sessions as tabs — ${selected().length} selected${truncated ? ` · newest ${sessions.length} shown` : ""}`
    }

    function previewHeader() {
      const id = previewId()
      if (id === undefined) return undefined
      const summary = summaries().find((entry: Summary) => entry.id === id)
      return `${summary?.title ?? id}${summary?.directory ? ` — ${summary.directory}` : ""}${summary?.updated ? ` (${summary.updated})` : ""}`
    }

    return {
      query: () => query(),
      setQuery: (value: string) => setQuerySignal(String(value ?? "")),
      titleLine,
      rows,
      highlightedId: () => highlight(),
      selectedIds: () => [...selected()],
      selectedCount: () => selected().length,
      truncated: () => truncated,
      previewOpen: () => previewId() !== undefined,
      previewLoading: () => previewLoading(),
      previewBody: () => previewBody(),
      previewHeader,
      togglePreview,
      closePreview,
      move,
      moveFirst: () => moveToIndex(0),
      moveLast: () => moveToIndex(rows().length - 1),
      toggle,
      toggleAt,
      selectShown,
      open,
      saveSet,
      takeRequest,
      resetRequests,
    }
  })
  return { ...controller, dispose: () => disposeRoot?.() }
}

// ---------------------------------------------------------------------------
// View: a thin Solid component that reads the controller reactively. All
// state lives in the controller, so re-showing the dialog (which remounts
// this component) loses nothing.
// ---------------------------------------------------------------------------

const COMMAND = {
  prev: "local.session-tabs.picker.prev",
  next: "local.session-tabs.picker.next",
  pageUp: "local.session-tabs.picker.page_up",
  pageDown: "local.session-tabs.picker.page_down",
  first: "local.session-tabs.picker.first",
  last: "local.session-tabs.picker.last",
  toggle: "local.session-tabs.picker.toggle",
  toggleKey: "local.session-tabs.picker.toggle_key",
  open: "local.session-tabs.picker.open",
  focusOpen: "local.session-tabs.picker.focus_open",
  preview: "local.session-tabs.picker.preview",
  selectShown: "local.session-tabs.picker.select_shown",
  save: "local.session-tabs.picker.save_set",
  back: "local.session-tabs.picker.back",
} as const

export type PickerCommand = {
  readonly id: string
  readonly title: string
  readonly group: string
  readonly bind: string
  readonly run: () => boolean | undefined | void
}

// The dialog's keymap commands, separated from the view so tests (and any
// embedding surface) can drive the exact same functions the keymap binds.
// Escape is bound last: with a preview open it consumes the key (closing only
// the preview); otherwise it returns false ("not handled") so the host's
// dialog layer closes the picker.
export function pickerCommands(c: PickerController): readonly PickerCommand[] {
  return [
    { id: COMMAND.prev, title: "Previous session", group: "Session Tabs", bind: "up", run: () => c.move(-1) },
    { id: COMMAND.next, title: "Next session", group: "Session Tabs", bind: "down", run: () => c.move(1) },
    { id: COMMAND.pageUp, title: "Page up", group: "Session Tabs", bind: "pageup", run: () => c.move(-10) },
    { id: COMMAND.pageDown, title: "Page down", group: "Session Tabs", bind: "pagedown", run: () => c.move(10) },
    { id: COMMAND.first, title: "First session", group: "Session Tabs", bind: "home", run: () => c.moveFirst() },
    { id: COMMAND.last, title: "Last session", group: "Session Tabs", bind: "end", run: () => c.moveLast() },
    { id: COMMAND.toggle, title: "Toggle selection", group: "Session Tabs", bind: "enter", run: () => c.toggle() },
    { id: COMMAND.toggleKey, title: "Toggle selection", group: "Session Tabs", bind: "ctrl+t", run: () => c.toggle() },
    { id: COMMAND.open, title: "Open tabs", group: "Session Tabs", bind: "ctrl+o", run: () => c.open(false) },
    { id: COMMAND.focusOpen, title: "Open and focus", group: "Session Tabs", bind: "ctrl+f", run: () => c.open(true) },
    { id: COMMAND.preview, title: "Preview session", group: "Session Tabs", bind: "ctrl+r", run: () => c.togglePreview() },
    { id: COMMAND.selectShown, title: "Select shown", group: "Session Tabs", bind: "ctrl+a", run: () => c.selectShown() },
    { id: COMMAND.save, title: "Save set", group: "Session Tabs", bind: "ctrl+s", run: () => c.saveSet() },
    {
      id: COMMAND.back,
      title: "Back",
      group: "Session Tabs",
      bind: "escape",
      run: () => {
        if (c.previewOpen()) {
          c.closePreview()
          return
        }
        return false
      },
    },
  ]
}

const FOOTER_ACTIONS: readonly { readonly id: string; readonly bind: string; readonly title: string }[] = [
  { id: COMMAND.toggle, bind: "enter", title: "toggle" },
  { id: COMMAND.open, bind: "ctrl+o", title: "open" },
  { id: COMMAND.focusOpen, bind: "ctrl+f", title: "focus" },
  { id: COMMAND.preview, bind: "ctrl+r", title: "preview" },
  { id: COMMAND.selectShown, bind: "ctrl+a", title: "select shown" },
  { id: COMMAND.save, bind: "ctrl+s", title: "save set" },
]

function pickerPalette(themeMode: string | undefined) {
  const light = themeMode === "light"
  return {
    base: light ? "#1f2328" : "#e6edf3",
    muted: light ? "#59636e" : "#8b949e",
    accent: light ? "#0969da" : "#58a6ff",
    check: light ? "#1a7f37" : "#3fb950",
  }
}

export function SessionPickerDialog(props: {
  readonly controller: PickerController
  /** Scoped keymap registration: the plugin's context.keymap.layer. */
  readonly layer: (factory: () => KeymapLayer) => void
  readonly shortcut?: (id: string) => readonly string[] | undefined
  readonly themeMode?: string
}): JSX.Element {
  const c = props.controller
  const colors = pickerPalette(props.themeMode)
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()

  // Bindings live only while this dialog component is mounted: the plugin
  // keymap layer API disposes the layer with the owning reactive scope.
  props.layer(() => ({
    mode: "modal",
    commands: pickerCommands(c) as KeymapLayer["commands"],
  }))

  // Focus the search input after mount, once layout settles — the same
  // pattern the host's own dialogs use. The value restores the persisted
  // query when the dialog is re-shown (it is read untracked so typing never
  // rewrites the buffer or moves the cursor).
  let inputRef: InputRenderable | undefined
  const attachInput = (node: InputRenderable) => {
    inputRef = node
    setTimeout(() => {
      if (inputRef === node && !node.isDestroyed) node.focus()
    }, 1)
  }

  let scroll: ScrollBoxRenderable | undefined
  let scrollScheduled = false
  function followHighlight() {
    if (!scroll || scroll.isDestroyed) return
    const index = c.rows().findIndex(row => row.active)
    if (index < 0) return
    const target = scroll.getChildren()[index]
    if (!target) return
    const y = target.y - scroll.y
    if (y >= scroll.height) scroll.scrollBy(y - scroll.height + 1)
    else if (y < 0) scroll.scrollBy(y)
  }
  function scheduleScroll() {
    if (scrollScheduled) return
    scrollScheduled = true
    renderer.once(CliRenderEvents.FRAME, () => {
      scrollScheduled = false
      followHighlight()
    })
    renderer.requestRender()
  }
  createEffect(() => {
    c.highlightedId()
    c.rows()
    scheduleScroll()
  })

  const listHeight = createMemo(() => {
    const lines = c.rows().length * 2 + 1
    return Math.max(3, Math.min(lines, Math.floor(dimensions().height / 2) - 4))
  })

  const keyFor = (action: { readonly id: string; readonly bind: string }) =>
    props.shortcut?.(action.id)?.[0] ?? action.bind

  return (
    <box flexDirection="column" gap={1} paddingBottom={1} paddingLeft={3} paddingRight={3}>
      <text attributes={TextAttributes.BOLD} fg={colors.base}>
        {c.titleLine()}
      </text>
      <input
        ref={attachInput}
        value={untrack(c.query)}
        onInput={value => c.setQuery(value)}
        placeholder="Search title, directory, session ID, or previewed text…"
        placeholderColor={colors.muted}
      />
      <box flexGrow={1} flexShrink={1} paddingLeft={1} paddingRight={1}>
        <Show
          when={c.previewOpen()}
          fallback={
            <Show
              when={c.rows().length > 0}
              fallback={
                <text fg={colors.muted}>
                  {c.query() ? `No sessions match "${c.query()}".` : "No sessions available."}
                </text>
              }
            >
              <scrollbox
                ref={(node: ScrollBoxRenderable) => {
                  scroll = node
                }}
                maxHeight={listHeight()}
                paddingLeft={1}
                paddingRight={1}
              >
                <For each={c.rows()}>
                  {row => (
                    <box
                      flexDirection="column"
                      onMouseUp={() => {
                        c.toggleAt(row.id)
                      }}
                    >
                      <box flexDirection="row" gap={1}>
                        <text flexShrink={0} fg={row.active ? colors.accent : undefined}>
                          {row.active ? "›" : " "}
                        </text>
                        <text
                          flexShrink={0}
                          fg={row.selected ? colors.check : undefined}
                          attributes={row.selected ? TextAttributes.BOLD : undefined}
                        >
                          {row.selected ? "✓" : " "}
                        </text>
                        <text
                          flexGrow={1}
                          overflow="hidden"
                          wrapMode="none"
                          fg={row.active ? colors.accent : colors.base}
                          attributes={row.active ? TextAttributes.BOLD : undefined}
                        >
                          {row.title}
                        </text>
                        <text flexShrink={0} fg={colors.muted} wrapMode="none">
                          {row.updated}
                        </text>
                      </box>
                      <box paddingLeft={2}>
                        <text fg={colors.muted} overflow="hidden" wrapMode="none">
                          {row.description}
                        </text>
                      </box>
                    </box>
                  )}
                </For>
              </scrollbox>
            </Show>
          }
        >
          <box flexDirection="column" gap={1}>
            <text attributes={TextAttributes.BOLD} fg={colors.base}>
              {c.previewHeader() ?? ""}
            </text>
            <Show when={!c.previewLoading()} fallback={<text fg={colors.muted}>Loading preview…</text>}>
              <text fg={colors.base} wrapMode="word">
                {c.previewBody() || "No messages in this session yet."}
              </text>
            </Show>
            <text fg={colors.muted}>ctrl+r or escape closes the preview</text>
          </box>
        </Show>
      </box>
      <box flexDirection="row" flexWrap="wrap" columnGap={2} rowGap={1} flexShrink={0}>
        <For each={FOOTER_ACTIONS}>
          {action => (
            <text fg={colors.base} wrapMode="none" flexShrink={0}>
              {action.title} <span style={{ fg: colors.muted }}>{keyFor(action)}</span>
            </text>
          )}
        </For>
      </box>
    </box>
  )
}

// ---------------------------------------------------------------------------
// Flow: shows the dialog, serves controller requests (open / save), re-shows
// after nested dialogs with every piece of picker state intact, and resolves
// with the same result shape the promise-based picker produced.
// ---------------------------------------------------------------------------

export type PickerDialogSurface = {
  show(render: () => JSX.Element, onClose?: () => void): unknown
  set?(options: { size?: "medium" | "large" | "xlarge"; centered?: boolean }): unknown
  clear(): unknown
  prompt(options: DialogPromptOptions): Promise<string | undefined>
  confirm(options: DialogConfirmOptions): Promise<boolean | undefined>
  alert(options: DialogAlertOptions): Promise<void>
}

export type SessionPickerDeps = {
  readonly dialog: PickerDialogSurface
  readonly layer: (factory: () => KeymapLayer) => void
  readonly shortcut?: (id: string) => readonly string[] | undefined
  readonly themeMode?: string
  readonly loadSessions: () => Promise<unknown>
  readonly openTabs: (sessionIDs: readonly string[], options?: { focus?: boolean }) => Promise<unknown>
  readonly loadPreviewText: (sessionID: string) => Promise<string>
  readonly saveWorkspace: (name: string, sessionIDs: readonly string[]) => Promise<unknown>
  readonly listWorkspaceNames: () => Promise<string[]>
  readonly toast: (options: { message: string; variant?: "info" | "success" | "warning" | "error" }) => void
  readonly openTabIDs?: () => readonly string[]
  readonly formatPath?: (value: string) => string
  readonly now?: () => number
  readonly tabsEnabled?: () => boolean
  /** Receives the picker controller once per invocation (used by tests). */
  readonly onController?: (controller: PickerController) => void
}

export async function runSessionPicker(deps: SessionPickerDeps) {
  const { dialog, layer } = deps
  const toast = deps.toast
  if (typeof deps.tabsEnabled === "function" && !deps.tabsEnabled()) {
    toast({ message: "Session tabs are disabled. Enable them in OpenCode settings first.", variant: "error" })
    return { status: "cancelled" }
  }
  if (typeof deps.loadSessions !== "function") {
    throw new Error("A loadSessions function is required for session discovery.")
  }
  let discovered
  try {
    discovered = await deps.loadSessions()
  } catch (error) {
    const message = errorMessage(error)
    toast({ message: `Could not load sessions from the server: ${message}`, variant: "error" })
    return { status: "error", message }
  }
  const sessions = Array.isArray(discovered)
    ? discovered
    : Array.isArray((discovered as { sessions?: unknown })?.sessions)
      ? ((discovered as { sessions: Record<string, unknown>[] }).sessions)
      : []
  const truncated = (discovered as { truncated?: boolean } | undefined)?.truncated === true
  if (!sessions.length) {
    await dialog.alert({ title: "Open sessions as tabs", message: "No sessions were found on the connected server." })
    return { status: "cancelled" }
  }
  const controller = createSessionPickerController({
    sessions,
    truncated,
    loadPreviewText: deps.loadPreviewText,
    openTabIDs: deps.openTabIDs,
    formatPath: deps.formatPath,
    now: deps.now,
    toast,
  })
  deps.onController?.(controller)
  try {
    const render = () =>
      SessionPickerDialog({
        controller,
        layer,
        shortcut: deps.shortcut,
        themeMode: deps.themeMode,
      })
    while (true) {
      // One dialog session per iteration. onClose resolves it; footer actions
      // resolve it through controller requests. Anything that replaces the
      // dialog (nested prompts, other plugins) ends the session and — unless
      // the flow itself is continuing — cancels the picker.
      let settleClosed: ((value: { readonly type: "closed" }) => void) | undefined
      let settled = false
      const closed = new Promise<{ readonly type: "closed" }>(resolve => {
        settleClosed = value => {
          if (settled) return
          settled = true
          resolve(value)
        }
      })
      controller.resetRequests()
      // Await the show: the host's dialog surface may yield a macrotask
      // before pushing the dialog, and its replace would reset any size set
      // in the meantime.
      await dialog.show(render, () => settleClosed?.({ type: "closed" }))
      dialog.set?.({ size: "large" })
      while (true) {
        const outcome = await Promise.race([closed, controller.takeRequest()])
        if (outcome.type === "closed") return { status: "cancelled" }
        if (outcome.type === "open") {
          const targets = controller.selectedIds()
          if (!targets.length && !outcome.fallback) continue // nothing to open; dialog stays up
          dialog.clear()
          if (!targets.length && outcome.fallback) {
            return runOpenTabs(deps.openTabs, toast, "Open", [outcome.fallback], { focus: outcome.focus })
          }
          return runOpenTabs(deps.openTabs, toast, "Open", targets, { focus: outcome.focus })
        }
        const ids = controller.selectedIds()
        if (!ids.length) {
          toast({ message: "Select sessions first: Enter or ctrl+t toggles selection.", variant: "warning" })
          continue
        }
        // prompt/confirm/alert replace the picker dialog (its onClose settles
        // the already-resolved race); afterwards the outer loop re-shows it
        // with query, highlight, selection, and preview intact.
        await promptAndSaveWorkspace({
          dialog: dialog as Parameters<typeof promptAndSaveWorkspace>[0]["dialog"],
          toast,
          listWorkspaceNames: deps.listWorkspaceNames,
          save: deps.saveWorkspace,
          sessionIDs: ids,
          suggestedName: undefined,
        })
        break
      }
    }
  } finally {
    controller.dispose()
  }
}
