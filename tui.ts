import { Plugin } from "@opencode/plugin/tui"
import { subscribeTui } from "./core.js"
import { SessionTabs } from "./rpc.ts"

export default Plugin.define({
  id: "local.session-tabs.tui",
  setup(context) {
    return subscribeTui(context, context.client.rpc(SessionTabs))
  },
})
