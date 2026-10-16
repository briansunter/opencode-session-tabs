import test from "node:test"
import assert from "node:assert/strict"
import { createBridge, discoverSessions, openTabsInTui, subscribeTui, validateSessionIDs } from "./core.js"

const input = { originSessionID: "ses_origin", sessionIDs: ["ses_one", "ses_two"] }

const session = (id, directory = "/code/app") => ({ id, title: id, location: { directory }, time: { updated: 1 } })

test("discovery follows cursors until the server stops offering pages", async () => {
  const calls = []
  const list = async (pageInput, options) => {
    calls.push({ pageInput, options })
    if (pageInput.cursor === undefined) return { data: [session("ses_a"), session("ses_b")], cursor: { next: "c2" } }
    if (pageInput.cursor === "c2") return { data: [session("ses_c")], cursor: { next: null } }
    throw new Error("unexpected cursor")
  }
  const result = await discoverSessions({ list })
  assert.deepEqual(result.sessions.map(entry => entry.id), ["ses_a", "ses_b", "ses_c"])
  assert.equal(result.pages, 2)
  assert.equal(result.truncated, false)
  assert.deepEqual(calls.map(call => call.pageInput), [
    { limit: 100, order: "desc" },
    { limit: 100, order: "desc", cursor: "c2" },
  ])
})

test("discovery deduplicates ids, skips malformed entries, and stops on empty pages", async () => {
  const list = async pageInput => {
    if (pageInput.cursor === undefined) {
      return { data: [session("ses_a"), session("ses_a"), null, { title: "no id" }, 7], cursor: { next: "c2" } }
    }
    return { data: [], cursor: { next: "c3" } } // empty page ends discovery defensively
  }
  const result = await discoverSessions({ list })
  assert.deepEqual(result.sessions.map(entry => entry.id), ["ses_a"])
  assert.equal(result.pages, 2)
  assert.equal(result.truncated, false)
})

test("discovery reports truncation when the page cap cuts the list short", async () => {
  let n = 0
  const list = async () => {
    n += 1
    return { data: [session(`ses_${n}`)], cursor: { next: "more" } }
  }
  const capped = await discoverSessions({ list, maxPages: 3, pageSize: 5 })
  assert.equal(capped.pages, 3)
  assert.equal(capped.truncated, true)
  assert.deepEqual(capped.sessions.map(entry => entry.id), ["ses_1", "ses_2", "ses_3"])
  const single = await discoverSessions({ list, maxPages: 1, pageSize: 5 })
  assert.deepEqual(single, { sessions: [session("ses_4")], pages: 1, truncated: true })
})

test("discovery stays bounded when a broken server repeats one page", async () => {
  const list = async () => ({ data: [session("ses_a")], cursor: { next: "same" } })
  const result = await discoverSessions({ list })
  assert.equal(result.pages, 10)
  assert.equal(result.truncated, true)
  assert.deepEqual(result.sessions.map(entry => entry.id), ["ses_a"], "repeated ids are deduplicated")
})

test("discovery forwards its abort signal to every page request", async () => {
  const controller = new AbortController()
  const seen = []
  const list = async (pageInput, options) => {
    seen.push(options.signal)
    return { data: [session("ses_a")], cursor: { next: null } }
  }
  await discoverSessions({ list, signal: controller.signal })
  assert.deepEqual(seen, [controller.signal])
})

test("discovery propagates page failures and validates its arguments", async () => {
  await assert.rejects(
    discoverSessions({ list: async () => { throw new Error("server exploded") } }),
    /server exploded/,
  )
  await assert.rejects(discoverSessions({}), /session list function/)
  for (const bad of [{ pageSize: 0 }, { maxPages: 0 }, { pageSize: 1.5 }, { maxPages: Number.NaN }]) {
    await assert.rejects(discoverSessions({ list: async () => ({}), ...bad }), /positive integers/)
  }
})

test("discovery lists only root sessions; child/subagent sessions are excluded", async () => {
  // Regression (live hit): the picker offered subagent sessions; opening one
  // landed on the parent's tab instead and then reported "did not retain".
  const roots = [session("ses_root1"), { ...session("ses_root2"), parentID: null }, { ...session("ses_root3"), parentID: "" }]
  const children = [
    { ...session("ses_child1"), parentID: "ses_root1" },
    { ...session("ses_child2"), parentID: "ses_child1" }, // nested subagent
  ]
  const result = await discoverSessions({ list: async () => ({ data: [...children, ...roots], cursor: { next: null } }) })
  assert.deepEqual(result.sessions.map(entry => entry.id), ["ses_root1", "ses_root2", "ses_root3"])
})

test("pages containing only child sessions still advance the cursor; later roots are never lost", async () => {
  const list = async pageInput => {
    if (pageInput.cursor === undefined) return { data: [{ ...session("ses_child"), parentID: "ses_root" }], cursor: { next: "p2" } }
    if (pageInput.cursor === "p2") return { data: [{ ...session("ses_child2"), parentID: "ses_root" }], cursor: { next: "p3" } }
    return { data: [session("ses_root")], cursor: { next: null } }
  }
  const result = await discoverSessions({ list })
  assert.deepEqual(result.sessions.map(entry => entry.id), ["ses_root"])
  assert.equal(result.pages, 3)
  assert.equal(result.truncated, false)
})

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

test("host failures thrown as plain objects report a readable error string", async () => {
  // The error field crosses the RPC complete schema as a string, so a
  // non-Error throw must still render its message, not "[object Object]".
  const h = host()
  h.context.ui.tabs.open = () => {
    throw { _tag: "RpcError", type: "rpc.internal", message: "tab host exploded" }
  }
  const result = await openTabsInTui(h.context, { sessionIDs: ["ses_one"] })
  assert.equal(result.error, "tab host exploded")
  assert.deepEqual(result.opened, [])
  assert.deepEqual(h.ids, ["ses_origin"])
})

test("child sessions are rejected before any tab opens, with the parent named", async () => {
  // Regression (live hit): a subagent session picked in the picker opened the
  // parent's tab and then reported "OpenCode did not retain" the child.
  const h = host()
  let openCalls = 0
  const realOpen = h.context.ui.tabs.open
  h.context.ui.tabs.open = id => { openCalls += 1; realOpen(id) }
  h.context.data.session.get = id => (id === "ses_child" ? { id, parentID: "ses_parent" } : { id })
  await assert.rejects(
    openTabsInTui(h.context, { sessionIDs: ["ses_child"] }),
    /ses_child is a child session\. Open parent ses_parent instead; child sessions appear inside parent\. No tabs were opened\./,
  )
  assert.equal(openCalls, 0)
  assert.deepEqual(h.ids, ["ses_origin"], "no tabs were opened")
})

test("a mixed batch of roots and children opens nothing at all", async () => {
  // The whole request is rejected rather than partially opened or silently
  // normalized to parent IDs: the reported result must match the request.
  const h = host()
  let openCalls = 0
  const realOpen = h.context.ui.tabs.open
  h.context.ui.tabs.open = id => { openCalls += 1; realOpen(id) }
  h.context.data.session.get = id => (id === "ses_child" ? { id, parentID: "ses_parent" } : { id })
  await assert.rejects(
    openTabsInTui(h.context, { sessionIDs: ["ses_one", "ses_child", "ses_two"] }),
    /Open parent ses_parent instead/,
  )
  assert.equal(openCalls, 0, "even the roots requested before the child were not opened")
  assert.deepEqual(h.ids, ["ses_origin"])
  assert.deepEqual(h.synced, ["ses_one", "ses_child", "ses_two"], "sessions were still preloaded")
})

test("hosts without a cached session getter keep opening (feature-checked preflight)", async () => {
  // Older hosts and test doubles expose only data.session.sync; without a
  // getter the child preflight is skipped, not a crash. ses_child would be
  // rejected if the getter existed.
  const h = host()
  assert.equal(typeof h.context.data.session.get, "undefined")
  const result = await openTabsInTui(h.context, { sessionIDs: ["ses_child"] })
  assert.deepEqual(result, { opened: ["ses_child"], alreadyOpen: [], focused: false })
})

test("an uncached session lookup is not treated as a child", async () => {
  const h = host()
  h.context.data.session.get = () => undefined // sync did not cache it: cannot classify
  const result = await openTabsInTui(h.context, { sessionIDs: ["ses_one"] })
  assert.deepEqual(result, { opened: ["ses_one"], alreadyOpen: [], focused: false })
})

test("child rejections cross the subscriber intact: error reported, nothing opened", async () => {
  const h = host()
  h.context.data.session.get = id => (id === "ses_child" ? { id, parentID: "ses_parent" } : { id })
  let listener
  const completions = []
  const rpc = {
    events: { on: (name, fn) => { listener = fn; return () => {} } },
    claim: async () => ({ claimed: true }),
    complete: async (data, options) => { completions.push({ data, options }) },
  }
  subscribeTui(h.context, rpc)
  await listener({
    location: { directory: "/project/origin" },
    data: { originSessionID: "ses_origin", sessionIDs: ["ses_child"], requestID: "req1", focus: false },
  })
  assert.equal(completions.length, 1)
  assert.deepEqual(completions[0].data.opened, [])
  assert.deepEqual(completions[0].data.alreadyOpen, [])
  assert.match(completions[0].data.error, /Open parent ses_parent instead; child sessions appear inside parent/)
  assert.deepEqual(h.ids, ["ses_origin"])
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
