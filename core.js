import { randomUUID } from "node:crypto"

export function validateSessionIDs(sessionIDs) {
  if (!Array.isArray(sessionIDs) || sessionIDs.length < 1 || sessionIDs.length > 20 ||
      sessionIDs.some(id => typeof id !== "string" || !/^ses[\w-]+$/.test(id))) {
    throw new Error("Provide between 1 and 20 existing session IDs beginning with ses.")
  }
  return [...new Set(sessionIDs)]
}

function tabSessionIDs(tabs) {
  return tabs.list().map(tab => tab.sessionID)
}

// State is scoped to one server plugin location; no files, sockets, or credentials.
export function createBridge({ getSession, emit, timeoutMs = 10000 }) {
  const pending = new Map()
  let disposed = false

  async function open(input, { signal } = {}) {
    if (disposed) throw new Error("Session-tabs plugin was unloaded.")
    const sessionIDs = validateSessionIDs(input.sessionIDs)
    if (typeof input.originSessionID !== "string" || !/^ses[\w-]+$/.test(input.originSessionID)) {
      throw new Error("An originating session is required to select the correct TUI.")
    }
    if (input.focus !== undefined && typeof input.focus !== "boolean") {
      throw new Error("focus must be a boolean.")
    }
    signal?.throwIfAborted()
    // Validate everything before emitting: a typo must not open a partial batch.
    for (const sessionID of new Set([input.originSessionID, ...sessionIDs])) {
      await getSession(sessionID, signal)
    }
    signal?.throwIfAborted()
    if (disposed) throw new Error("Session-tabs plugin was unloaded.")
    const requestID = randomUUID()
    return new Promise((resolve, reject) => {
      let timer
      const finish = (error, value) => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
        pending.delete(requestID)
        if (error) reject(error)
        else resolve(value)
      }
      const abort = () => finish(new Error("Tab-opening request cancelled; any tabs already opened are left intact."))
      pending.set(requestID, { sessionIDs, finish, clientID: undefined })
      signal?.addEventListener("abort", abort, { once: true })
      timer = setTimeout(() => finish(new Error(
        "No TUI confirmation received. Load this plugin in the TUI and keep the originating session open. " +
        "The request has expired; any tabs already opened are left intact."
      )), timeoutMs)
      Promise.resolve().then(() => emit({
        requestID,
        originSessionID: input.originSessionID,
        sessionIDs,
        focus: input.focus === true,
      })).catch(error => finish(error))
    })
  }

  return {
    open,
    claim({ requestID, clientID }) {
      const request = pending.get(requestID)
      if (!request || request.clientID) return { claimed: false }
      request.clientID = clientID
      return { claimed: true }
    },
    complete({ requestID, clientID, opened, alreadyOpen, focused, error }) {
      const request = pending.get(requestID)
      if (!request || !request.clientID || request.clientID !== clientID) return { accepted: false }
      if (!Array.isArray(opened) || !Array.isArray(alreadyOpen) ||
          [...opened, ...alreadyOpen].some(id => !request.sessionIDs.includes(id))) {
        request.finish(new Error("TUI returned an invalid tab acknowledgement."))
      } else if (error) {
        request.finish(new Error(`TUI: ${error} Confirmed opened: ${opened.join(", ") || "none"}.`))
      } else if (!request.sessionIDs.every(id => opened.includes(id) || alreadyOpen.includes(id))) {
        request.finish(new Error("TUI did not confirm every requested tab."))
      } else {
        request.finish(undefined, { opened, alreadyOpen, focused })
      }
      return { accepted: true }
    },
    dispose() {
      disposed = true
      for (const request of pending.values()) request.finish(new Error("Session-tabs plugin was unloaded."))
    },
  }
}

export async function openTabsInTui(context, input) {
  const ids = validateSessionIDs(input.sessionIDs)
  const tabs = context.ui.tabs
  if (!tabs.enabled()) throw new Error("Session tabs are disabled. Enable them in OpenCode settings first.")
  // Preload all sessions before opening anything, including cross-project sessions.
  for (const id of ids) await context.data.session.sync(id)
  const before = new Set(tabSessionIDs(tabs))
  const opened = []
  const alreadyOpen = []
  try {
    for (const id of ids) {
      if (before.has(id)) alreadyOpen.push(id)
      else {
        await tabs.open(id)
        // Opening a cross-project tab can asynchronously sync its location.
        const deadline = Date.now() + 1500
        while (!tabSessionIDs(tabs).includes(id) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        if (!tabSessionIDs(tabs).includes(id)) throw new Error(`OpenCode did not retain tab ${id}.`)
        opened.push(id)
      }
    }
    if (input.focus === true) tabs.focus(ids.at(-1))
    return { opened, alreadyOpen, focused: input.focus === true }
  } catch (error) {
    return { opened, alreadyOpen, focused: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function subscribeTui(context, rpc) {
  const clientID = randomUUID()
  let disposed = false
  const stop = rpc.events.on("requested", async event => {
    // An unrelated TUI must never react to another session's requests.
    const route = context.ui.router.current()
    const input = event.data
    if (disposed || !(route.type === "session" && route.sessionID === input.originSessionID) &&
        !tabSessionIDs(context.ui.tabs).includes(input.originSessionID)) return
    const options = { location: event.location, signal: AbortSignal.timeout(10000) }
    try {
      const result = await rpc.claim({ requestID: input.requestID, clientID }, options)
      if (!result.claimed || disposed) return
      let outcome
      try {
        outcome = await openTabsInTui(context, input)
      } catch (error) {
        outcome = { opened: [], alreadyOpen: [], focused: false, error: error instanceof Error ? error.message : String(error) }
      }
      await rpc.complete({ requestID: input.requestID, clientID, ...outcome }, options)
    } catch {
      // RPC/source failures must not reject the callback and kill its listener.
      context.ui.toast.show({ message: "Session-tabs request failed; no success was reported.", variant: "error" })
    }
  })
  return () => { disposed = true; stop() }
}
