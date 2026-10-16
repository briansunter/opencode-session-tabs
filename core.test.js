import test from "node:test"
import assert from "node:assert/strict"
import { createBridge, openTabsInTui, subscribeTui, validateSessionIDs } from "./core.js"

const input = { originSessionID: "ses_origin", sessionIDs: ["ses_one", "ses_two"] }

function host({ enabled = true, failSync, failOpen } = {}) {
  const ids = ["ses_origin"]
  const synced = []
  let focused = "ses_origin"
  const context = {
    data: { session: { sync: async id => { if (id === failSync) throw new Error("Missing session"); synced.push(id) } } },
    ui: {
      tabs: {
        enabled: () => enabled,
        list: () => ids.map(sessionID => ({ sessionID, title: sessionID, active: sessionID === focused })),
        open: id => { if (id === failOpen) return; if (!ids.includes(id)) ids.push(id) },
        focus: id => { focused = id },
      },
      router: { current: () => ({ type: "session", sessionID: "ses_origin" }) },
      toast: { show() {} },
    },
  }
  return { context, ids, synced, focused: () => focused }
}

test("validates bounded session IDs and deduplicates", () => {
  assert.deepEqual(validateSessionIDs(["ses_one", "ses_one"]), ["ses_one"])
  for (const value of [[], ["other"], ["ses_!"], Array(21).fill("ses_one"), null]) {
    assert.throws(() => validateSessionIDs(value))
  }
})

test("opens cross-project sessions in order, preserves focus, and is idempotent", async () => {
  const h = host()
  const result = await openTabsInTui(h.context, input)
  assert.deepEqual(result, { opened: ["ses_one", "ses_two"], alreadyOpen: [], focused: false })
  assert.equal(h.focused(), "ses_origin")
  assert.deepEqual(h.synced, ["ses_one", "ses_two"])
  const again = await openTabsInTui(h.context, { ...input, focus: true })
  assert.deepEqual(again, { opened: [], alreadyOpen: ["ses_one", "ses_two"], focused: true })
  assert.equal(h.focused(), "ses_two")
})

test("disabled tabs and failed preload never open a partial batch", async () => {
  for (const options of [{ enabled: false }, { failSync: "ses_two" }]) {
    const h = host(options)
    await assert.rejects(openTabsInTui(h.context, input))
    assert.deepEqual(h.ids, ["ses_origin"])
  }
})

test("waits for asynchronously projected tabs before confirming success", async () => {
  const h = host()
  h.context.ui.tabs.open = id => { setTimeout(() => h.ids.push(id), 40) }
  const result = await openTabsInTui(h.context, { sessionIDs: ["ses_one"] })
  assert.deepEqual(result, { opened: ["ses_one"], alreadyOpen: [], focused: false })
  assert.equal(h.focused(), "ses_origin")
})

test("partial host failures report confirmed tabs without closing anything", async () => {
  const h = host({ failOpen: "ses_two" })
  const result = await openTabsInTui(h.context, input)
  assert.deepEqual(result.opened, ["ses_one"])
  assert.match(result.error, /did not retain/)
  assert.deepEqual(h.ids, ["ses_origin", "ses_one"])
})

test("bridge validates all existing sessions before emitting", async () => {
  let emitted = false
  const bridge = createBridge({
    getSession: async id => { if (id === "ses_two") throw new Error("not found") },
    emit: () => { emitted = true },
  })
  await assert.rejects(bridge.open(input), /not found/)
  assert.equal(emitted, false)
})

test("only one client claims a request; mismatched acknowledgement is ignored", async () => {
  let request
  const bridge = createBridge({ getSession: async () => {}, emit: data => {
    request = data
    assert.deepEqual(bridge.claim({ requestID: data.requestID, clientID: "a" }), { claimed: true })
    assert.deepEqual(bridge.claim({ requestID: data.requestID, clientID: "b" }), { claimed: false })
    assert.deepEqual(bridge.complete({ requestID: data.requestID, clientID: "b" }), { accepted: false })
    bridge.complete({ requestID: data.requestID, clientID: "a", opened: data.sessionIDs, alreadyOpen: [], focused: false })
  } })
  const result = await bridge.open(input)
  assert.deepEqual(result.opened, input.sessionIDs)
  assert.equal(request.focus, false)
  assert.deepEqual(bridge.claim({ requestID: request.requestID, clientID: "a" }), { claimed: false })
})

test("missing TUI times out, expires request, and never claims late", async () => {
  let request
  const bridge = createBridge({ getSession: async () => {}, emit: data => { request = data }, timeoutMs: 10 })
  await assert.rejects(bridge.open(input), /No TUI confirmation/)
  assert.deepEqual(bridge.claim({ requestID: request.requestID, clientID: "a" }), { claimed: false })
})

test("cancellation and plugin cleanup expire pending requests", async () => {
  for (const cancel of [true, false]) {
    const controller = new AbortController()
    let request
    const bridge = createBridge({ getSession: async () => {}, emit: data => {
      request = data
      if (cancel) controller.abort()
      else bridge.dispose()
    } })
    await assert.rejects(bridge.open(input, { signal: controller.signal }), cancel ? /cancelled/ : /unloaded/)
    assert.deepEqual(bridge.claim({ requestID: request.requestID, clientID: "a" }), { claimed: false })
  }
})

test("incomplete acknowledgements cannot report success", async () => {
  const bridge = createBridge({ getSession: async () => {}, emit: data => {
    bridge.claim({ requestID: data.requestID, clientID: "a" })
    bridge.complete({ requestID: data.requestID, clientID: "a", opened: ["ses_one"], alreadyOpen: [], focused: false })
  } })
  await assert.rejects(bridge.open(input), /did not confirm every/)
})

test("TUI subscriber routes by origin and uses the event location for RPC", async () => {
  const h = host()
  let listener, stopped = false
  const claims = [], completions = []
  const rpc = {
    events: { on: (name, fn) => { assert.equal(name, "requested"); listener = fn; return () => { stopped = true } } },
    claim: async (data, options) => { claims.push({ data, options }); return { claimed: true } },
    complete: async (data, options) => { completions.push({ data, options }) },
  }
  const dispose = subscribeTui(h.context, rpc)
  const event = { location: { directory: "/project/origin" }, data: { ...input, requestID: "req1", focus: false } }
  await listener({ ...event, data: { ...event.data, originSessionID: "ses_unrelated" } })
  assert.equal(claims.length, 0)
  await listener(event)
  assert.equal(claims.length, 1)
  assert.deepEqual(completions[0].data.opened, input.sessionIDs)
  assert.deepEqual(completions[0].options.location, event.location)
  dispose()
  assert.equal(stopped, true)
  await listener(event)
  assert.equal(claims.length, 1)
})
