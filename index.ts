import { Plugin } from "@opencode/plugin"
import { createBridge, createWorkspaceStore } from "./core.js"
import { openInput, SessionTabs } from "./rpc.ts"

type WorkspaceRecord = {
  name: string
  sessionIDs: string[]
  createdAt: number
  updatedAt: number
}

export default Plugin.define({
  id: "local.session-tabs",
  async setup(ctx) {
    let emit: (data: unknown) => Promise<void>
    const bridge = createBridge({
      getSession: (sessionID: string, signal?: AbortSignal) => ctx.session.get({ sessionID }, { signal }),
      emit: (data: unknown) => emit(data),
    })
    // Saved session sets live in plugin storage and are revalidated on every
    // read; corrupt entries degrade to missing instead of failing the plugin.
    const workspaces = createWorkspaceStore({
      read: () => ctx.storage.get("workspaces"),
      write: (value: { workspaces: Record<string, { sessionIDs: string[]; createdAt: number; updatedAt: number }> }) =>
        ctx.storage.set("workspaces", value),
      exists: async (sessionID: string, signal?: AbortSignal) => {
        try {
          await ctx.session.get({ sessionID }, { signal })
          return true
        } catch {
          return false
        }
      },
    })
    const registration = await ctx.rpc.register(SessionTabs, {
      open: (input, context) =>
        bridge.open(input as { originSessionID: string; sessionIDs: string[]; focus?: boolean }, { signal: context.signal }),
      claim: async input => bridge.claim(input as { requestID: string; clientID: string }),
      complete: async input => {
        const data = input as {
          requestID: string
          clientID: string
          opened: string[]
          alreadyOpen: string[]
          focused: boolean
          error?: string
        }
        return bridge.complete({ ...data, error: data.error })
      },
      workspaceList: async () => ({ workspaces: (await workspaces.list()) as WorkspaceRecord[] }),
      workspaceSave: async (input: unknown, context) => {
        const data = input as { name: string; sessionIDs: string[] }
        return workspaces.save(data, { signal: context.signal })
      },
      workspaceRemove: async (input: unknown) => workspaces.remove(input as { name: string }),
    })
    emit = data =>
      registration.events.emit(
        "requested",
        data as { requestID: string; originSessionID: string; sessionIDs: string[]; focus: boolean },
      )

    await ctx.tool.transform(editor => {
      editor.add({
        name: "open_session_tabs",
        description: "Open 1–20 existing OpenCode sessions as tabs in the TUI containing this session. " +
          "Pass sessionIDs, or workspace to open a named set saved from the TUI session picker. " +
          "Only top-level sessions can be tabs: child (subagent) sessions appear inside their parent's tab and are rejected with the parent ID. " +
          "Does not send prompts, resume execution, create sessions, or close tabs. " +
          "Preserves focus unless focus=true (focuses the last requested tab). " +
          "Requires this plugin in a connected TUI with tabs enabled; waits for confirmation. " +
          "If this session is open in multiple TUIs, the first responding TUI handles the batch.",
        input: openInput,
        execute: async (input, context) => {
          const request = input as { sessionIDs?: string[]; focus?: boolean; workspace?: string }
          let sessionIDs = request.sessionIDs
          if (request.workspace !== undefined) {
            if (sessionIDs !== undefined) throw new Error("Pass either sessionIDs or workspace, not both.")
            const set = await workspaces.get(request.workspace)
            if (!set) throw new Error(`No saved session set named "${request.workspace}". Save sets from the TUI session picker or workspaces command.`)
            sessionIDs = set.sessionIDs
          } else if (sessionIDs === undefined) {
            throw new Error("Provide sessionIDs or a saved workspace name.")
          }
          const result = await bridge.open({ sessionIDs, originSessionID: context.sessionID, focus: request.focus }, { signal: context.signal })
          return { content: JSON.stringify(result) }
        },
      })
    })
    return () => bridge.dispose()
  },
})
