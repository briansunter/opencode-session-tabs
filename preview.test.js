import test from "node:test"
import assert from "node:assert/strict"
import {
  createPreviewLoader,
  createPreviewSource,
  createSelection,
  filterSessions,
  formatRelativeTime,
  recentSessionText,
  summarizeSessions,
} from "./core.js"

const NOW = 1_700_000_000_000

test("relative times cover minutes through years", () => {
  assert.equal(formatRelativeTime(NOW, NOW - 10_000), "just now")
  assert.equal(formatRelativeTime(NOW, NOW - 5 * 60_000), "5m ago")
  assert.equal(formatRelativeTime(NOW, NOW - 3 * 3_600_000), "3h ago")
  assert.equal(formatRelativeTime(NOW, NOW - 2 * 86_400_000), "2d ago")
  assert.equal(formatRelativeTime(NOW, NOW - 30 * 86_400_000), "Oct 15")
  assert.equal(formatRelativeTime(NOW, new Date("2022-01-05").getTime()), "Jan 5, 2022")
  assert.equal(formatRelativeTime(NOW, undefined), "unknown")
  assert.equal(formatRelativeTime(NOW, Number.NaN), "unknown")
})

test("summaries order by recency, default titles, shorten directories, and mark open tabs", () => {
  const summaries = summarizeSessions(
    [
      { id: "ses_old", title: "Older", location: { directory: "/code/app" }, time: { updated: NOW - 10 } },
      { id: "ses_new", location: { directory: "/code/docs" }, time: { updated: NOW - 1 } },
      { id: "ses_open", title: "Open one", directory: "/code/app", time: { updated: NOW - 5 } },
    ],
    { now: NOW, openIDs: ["ses_open"], formatPath: value => value.replace("/code", "~") },
  )
  assert.deepEqual(summaries.map(summary => summary.id), ["ses_new", "ses_open", "ses_old"])
  assert.equal(summaries[0].title, "Untitled session")
  assert.equal(summaries[0].directory, "~/docs")
  assert.equal(summaries[0].category, "docs")
  assert.equal(summaries[0].updated, "just now")
  assert.equal(summaries[1].open, true)
  assert.equal(summaries[2].open, false)
})

test("recent text extracts the last user prompt and assistant reply on single lines", () => {
  const text = recentSessionText([
    { type: "user", text: "first prompt", time: { created: 1 } },
    { type: "assistant", content: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "first answer" }] },
    { type: "user", text: "  fix\n  the bug  " },
    { type: "assistant", content: [{ type: "tool", tool: "edit" }] },
    { type: "assistant", content: [{ type: "text", text: "  done\n  already" }] },
  ])
  assert.equal(text, "You: fix the bug\nAgent: done already")
})

test("recent text ignores tool and system messages and truncates long lines", () => {
  const long = "x".repeat(400)
  const text = recentSessionText([
    { type: "system", text: "system noise" },
    { type: "assistant", content: [{ type: "text", text: long }] },
  ], { maxChars: 100 })
  assert.equal(text, `Agent: ${"x".repeat(49)}…`)
  assert.equal(recentSessionText([]), "")
  assert.equal(recentSessionText([{ type: "tool", tool: "edit" }]), "")
})

test("filtering requires every whitespace-separated term across previewable fields", () => {
  const summaries = [
    { id: "ses_a", title: "Fix login", directory: "~/app", preview: "You: oauth token expired" },
    { id: "ses_b", title: "Write docs", directory: "~/docs", preview: "" },
  ]
  assert.deepEqual(filterSessions("login", summaries), [summaries[0]])
  assert.deepEqual(filterSessions("fix  app", summaries), [summaries[0]])
  assert.deepEqual(filterSessions("oauth", summaries), [summaries[0]]) // searches preview text
  assert.deepEqual(filterSessions("ses_b", summaries), [summaries[1]]) // searches IDs
  assert.deepEqual(filterSessions("login docs", summaries), [])
  assert.deepEqual(filterSessions("", summaries), summaries)
  assert.deepEqual(filterSessions(undefined, summaries), summaries)
})

test("preview loader lets only the newest request cache or report", async () => {
  const gates = {}
  const loader = createPreviewLoader({
    load: id =>
      new Promise(resolve => {
        gates[id] = value => resolve(value)
      }),
  })
  const first = loader.load("ses_a")
  const second = loader.load("ses_b")
  gates.ses_b("latest text")
  assert.equal(await second, "latest text")
  gates.ses_a("stale text")
  assert.equal(await first, null, "superseded load resolves null")
  assert.equal(loader.peek("ses_a"), undefined)
  assert.equal(loader.peek("ses_b"), "latest text")
  // The cached value is reused without another load.
  assert.equal(await loader.load("ses_b"), "latest text")
})

test("preview loader reports failures as empty without caching", async () => {
  let failures = 0
  const loader = createPreviewLoader({
    load: async () => {
      failures++
      throw new Error("boom")
    },
  })
  assert.equal(await loader.load("ses_a"), "")
  assert.equal(loader.peek("ses_a"), undefined)
  assert.equal(failures, 1)
  assert.equal(await loader.load("ses_a"), "")
  assert.equal(failures, 2, "failures are not cached")
})

test("preview source prefers the data cache and only falls back to the client when it holds nothing", async () => {
  const calls = { sync: [], client: [] }
  const cachedMessages = [
    { type: "user", text: "cached prompt" },
    { type: "assistant", content: [{ type: "text", text: "cached answer" }] },
  ]
  const source = createPreviewSource({
    sync: async id => { calls.sync.push(id) },
    cached: id => (id === "ses_local" ? cachedMessages : []),
    listMessages: async id => {
      calls.client.push(id)
      return { data: [{ type: "user", text: "remote prompt" }, { type: "assistant", content: [{ type: "text", text: "remote answer" }] }] }
    },
  })
  assert.equal(await source("ses_local"), "You: cached prompt\nAgent: cached answer")
  assert.deepEqual(calls, { sync: ["ses_local"], client: [] })
})

test("preview source falls back to the client when the data cache has never loaded the session", async () => {
  // Cross-location session: the TUI cache path fails or comes back empty.
  for (const sync of [
    async () => { throw new Error("cache sync failed") },
    async () => {},
  ]) {
    const clientCalls = []
    const source = createPreviewSource({
      sync,
      cached: () => [],
      listMessages: async id => {
        clientCalls.push(id)
        return { data: [{ type: "user", text: "remote prompt" }] }
      },
    })
    assert.equal(await source("ses_remote"), "You: remote prompt")
    assert.deepEqual(clientCalls, ["ses_remote"])
  }
})

test("preview source reports no text when neither source has messages", async () => {
  const source = createPreviewSource({
    sync: async () => {},
    cached: () => [],
    listMessages: async () => ({ data: [] }),
  })
  assert.equal(await source("ses_empty"), "")
})

test("selection tracks toggles, bulk changes, and stable order", () => {
  const selection = createSelection()
  selection.toggle("ses_b")
  selection.toggle("ses_a")
  assert.deepEqual(selection.ids(), ["ses_b", "ses_a"])
  selection.toggle("ses_b")
  assert.deepEqual(selection.ids(), ["ses_a"])
  selection.addMany(["ses_c", "ses_d"])
  assert.equal(selection.count(), 3)
  selection.removeMany(["ses_a", "ses_d"])
  assert.deepEqual(selection.ids(), ["ses_c"])
  selection.clear()
  assert.equal(selection.count(), 0)
  assert.deepEqual(createSelection(["ses_x"]).ids(), ["ses_x"])
})
