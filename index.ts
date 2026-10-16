import { Plugin } from "@opencode/plugin"
import { createBridge } from "./core.js"
import { openInput, SessionTabs } from "./rpc.ts"

export default Plugin.define({
  id: "local.session-tabs",
  async setup(ctx) {
    let emit: (data: unknown) => Promise<void>
    const bridge = createBridge({
      getSession: (sessionID: string, signal?: AbortSignal) => ctx.session.get({ sessionID }, { signal }),
      emit: (data: unknown) => emit(data),
    })
    const registration = await ctx.rpc.register(SessionTabs, {
      open: (input, context) => bridge.open(input, { signal: context.signal }),
      claim: async input => bridge.claim(input),
      complete: async input => bridge.complete(input),
    })
    emit = data => registration.events.emit("requested", data)

    await ctx.tool.transform(editor => {
      editor.add({
        name: "open_session_tabs",
        description: "Open 1–20 existing OpenCode sessions as tabs in the TUI containing this session. " +
          "Does not send prompts, resume execution, create sessions, or close tabs. " +
          "Preserves focus unless focus=true (focuses the last requested tab). " +
          "Requires this plugin in a connected TUI with tabs enabled; waits for confirmation. " +
          "If this session is open in multiple TUIs, the first responding TUI handles the batch.",
        input: openInput,
        execute: async (input, context) => {
          const result = await bridge.open({ ...input as object, originSessionID: context.sessionID }, { signal: context.signal })
          return { content: JSON.stringify(result) }
        },
      })
    })
    return () => bridge.dispose()
  },
})
