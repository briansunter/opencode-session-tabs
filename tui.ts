import { Plugin } from "@opencode/plugin/tui"
import type { DialogSelectOptions } from "@opencode/plugin/tui/context"
import {
  createPreviewSource,
  discoverSessions,
  errorMessage,
  openTabsInTui,
  runWorkspaceManager,
  subscribeTui,
} from "./core.js"
import { runSessionPicker } from "./picker.tsx"
import { SessionTabs } from "./rpc.ts"

type WorkspaceRecord = {
  name: string
  sessionIDs: string[]
  createdAt: number
  updatedAt: number
}

function bindFromOption(value: unknown, fallback: string): string | false {
  if (value === false) return false
  if (typeof value === "string" && value.trim()) return value.trim()
  return fallback
}

export default Plugin.define({
  id: "local.session-tabs.tui",
  setup(context) {
    const stopTabs = subscribeTui(context, context.client.rpc(SessionTabs))

    // Nested dialogs (save-set prompts, workspace confirmations) clear the
    // active dialog and the flow re-shows it immediately. Yield one macrotask
    // before every dialog call so the host finishes its key dispatch before a
    // new dialog is pushed.
    const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
    const hostDialog = context.ui.dialog
    const dialog = {
      async show(render: Parameters<typeof hostDialog.show>[0], onClose?: () => void) {
        await tick()
        hostDialog.show(render, onClose)
      },
      set(options: Parameters<typeof hostDialog.set>[0]) {
        hostDialog.set(options)
      },
      async select<T>(options: DialogSelectOptions<T>) {
        await tick()
        return hostDialog.select(options)
      },
      async prompt(options: Parameters<typeof hostDialog.prompt>[0]) {
        await tick()
        return hostDialog.prompt(options)
      },
      async confirm(options: Parameters<typeof hostDialog.confirm>[0]) {
        await tick()
        return hostDialog.confirm(options)
      },
      async alert(options: Parameters<typeof hostDialog.alert>[0]) {
        await tick()
        return hostDialog.alert(options)
      },
      clear() {
        hostDialog.clear()
      },
    }

    const workspaceRpc = context.client.rpc(SessionTabs)
    const rpcLocation = () => context.location ?? context.data.location.default()
    const listWorkspaces = async (): Promise<{ workspaces: WorkspaceRecord[] }> =>
      workspaceRpc.workspaceList({}, { location: rpcLocation() }) as Promise<{ workspaces: WorkspaceRecord[] }>
    const saveWorkspace = async (name: string, sessionIDs: readonly string[]): Promise<WorkspaceRecord> =>
      workspaceRpc.workspaceSave({ name, sessionIDs: [...sessionIDs] }, { location: rpcLocation() }) as Promise<WorkspaceRecord>
    const removeWorkspace = async (name: string): Promise<{ removed: boolean }> =>
      workspaceRpc.workspaceRemove({ name }, { location: rpcLocation() }) as Promise<{ removed: boolean }>

    const openTabs = async (sessionIDs: readonly string[], { focus = false } = {}) => {
      if (!context.ui.tabs.enabled()) {
        throw new Error("Session tabs are disabled. Enable them in OpenCode settings first.")
      }
      return openTabsInTui(context, { sessionIDs: [...sessionIDs], focus: focus === true })
    }

    // Session previews: the data cache is keyed by sessionID and works for
    // sessions from any location; a direct client message fetch backs it up
    // for sessions this TUI has never loaded.
    const loadPreviewText = createPreviewSource({
      sync: (sessionID: string) => context.data.session.message.sync(sessionID),
      cached: (sessionID: string) => context.data.session.message.list(sessionID),
      listMessages: (sessionID: string) => context.client.message.list({ sessionID }),
    })

    const tabsEnabled = () => context.ui.tabs.enabled()
    const openTabIDs = () => context.ui.tabs.list().map(tab => tab.sessionID)
    const formatPath = (value: string) => context.ui.format.path(value)

    // One interactive flow at a time; re-running a command while its dialog is
    // open is ignored instead of stacking a second modal.
    let busy = false
    const runExclusively = (flow: () => Promise<unknown>) => () => {
      if (busy) return
      busy = true
      void Promise.resolve().then(flow).catch(error => {
        context.ui.toast.show({
          message: errorMessage(error),
          variant: "error",
        })
      }).finally(() => { busy = false })
    }

    // Global session discovery for the picker. context.data.session.list()
    // only returns sessions this TUI already cached, so a fresh home
    // directory would list nothing; client.session.list with no
    // directory/project filter lists every session on the connected server,
    // across all locations, via cursor pagination. Bounded by a timeout so a
    // hung server cannot wedge the command (and its busy guard) forever.
    const listSessions = (
      input: { limit?: number; order?: "asc" | "desc"; cursor?: string },
      requestOptions?: { signal?: AbortSignal },
    ) => context.client.session.list(input, requestOptions)

    const picker = () =>
      runSessionPicker({
        dialog,
        layer: context.keymap.layer,
        shortcut: context.keymap.shortcuts,
        themeMode: context.themeMode,
        loadSessions: async () => discoverSessions({ list: listSessions, signal: AbortSignal.timeout(15000) }),
        openTabs,
        loadPreviewText,
        saveWorkspace,
        listWorkspaceNames: async () => (await listWorkspaces()).workspaces.map(set => set.name),
        toast: (options: { message: string; variant?: "info" | "success" | "warning" | "error" }) =>
          context.ui.toast.show(options),
        openTabIDs,
        formatPath,
        now: () => Date.now(),
        tabsEnabled,
      })

    const workspaces = () =>
      runWorkspaceManager({
        dialog,
        toast: (options: { message: string; variant?: "info" | "success" | "warning" | "error" }) =>
          context.ui.toast.show(options),
        listWorkspaces,
        saveWorkspace,
        removeWorkspace,
        getSession: async (sessionID: string) => {
          await context.client.session.get({ sessionID })
        },
        sessionTitle: (sessionID: string) => context.data.session.get(sessionID)?.title,
        openTabs,
        openTabIDs,
        now: () => Date.now(),
        tabsEnabled,
      })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "local.session-tabs.picker",
          title: "Open sessions as tabs",
          description: "Search sessions, select several, and open them as background tabs (ctrl+f focuses the last).",
          group: "Session Tabs",
          palette: true,
          slash: { name: "tabs" },
          suggested: true,
          bind: bindFromOption(context.options.pickerBind, "<leader>p"),
          run: runExclusively(picker),
        },
        {
          id: "local.session-tabs.workspaces",
          title: "Open saved session set",
          description: "Open, prune, delete, or save named sets of sessions (workspaces).",
          group: "Session Tabs",
          palette: true,
          slash: { name: "workspaces" },
          suggested: true,
          bind: bindFromOption(context.options.workspacesBind, "<leader>k"),
          run: runExclusively(workspaces),
        },
      ],
    }))

    return () => stopTabs()
  },
})
