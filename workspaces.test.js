import test from "node:test"
import assert from "node:assert/strict"
import {
  createWorkspaceStore,
  normalizeWorkspaceCollection,
  resolveExistingSessions,
  validateWorkspaceName,
} from "./core.js"

function memoryStorage(initial) {
  let value = initial
  return {
    read: async () => value,
    write: async next => {
      value = next
    },
    snapshot: () => value,
  }
}

const storeDeps = ({ existing = ["ses_a", "ses_b"], storage } = {}) => {
  const memory = storage ?? memoryStorage()
  return {
    memory,
    existsCalls: [],
    store: createWorkspaceStore({
      read: memory.read,
      write: memory.write,
      exists: async id => {
        return existing.includes(id)
      },
    }),
  }
}

test("workspace names are trimmed, bounded, and control-character free", () => {
  assert.equal(validateWorkspaceName("  daily  "), "daily")
  assert.equal(validateWorkspaceName("a".repeat(64)), "a".repeat(64))
  for (const bad of ["", "   ", "a".repeat(65), "line\nbreak", "tab\tchar", 42, null, undefined]) {
    assert.throws(() => validateWorkspaceName(bad), /name/i)
  }
})

test("normalization keeps valid sets, skips corrupt ones, and sorts by recency", () => {
  const list = normalizeWorkspaceCollection({
    fresh: { sessionIDs: ["ses_a"], createdAt: 2, updatedAt: 20 },
    "older set": { sessionIDs: ["ses_b", "ses_b"], createdAt: 1, updatedAt: 10 },
    bad_ids: { sessionIDs: ["nope"], createdAt: 1, updatedAt: 99 },
    bad_time: { sessionIDs: ["ses_c"], createdAt: "x", updatedAt: 99 },
    bad_shape: "not an object",
  })
  assert.deepEqual(list.map(entry => entry.name), ["fresh", "older set"])
  assert.deepEqual(list[1].sessionIDs, ["ses_b"]) // deduplicated
  for (const garbage of [undefined, null, 7, "x", [], [{}]]) {
    assert.deepEqual(normalizeWorkspaceCollection(garbage), [])
  }
})

test("saving validates names and deduplicates bounded session lists", async () => {
  const { store, memory } = storeDeps()
  const record = await store.save({ name: " review ", sessionIDs: ["ses_a", "ses_b", "ses_a"] })
  assert.equal(record.name, "review")
  assert.deepEqual(record.sessionIDs, ["ses_a", "ses_b"])
  const saved = memory.snapshot().workspaces.review
  assert.equal(saved.createdAt, record.createdAt)
  const again = await store.save({ name: "review", sessionIDs: ["ses_b"] })
  assert.equal(again.createdAt, record.createdAt, "overwrites keep createdAt")
  assert.deepEqual((await store.list()).map(entry => entry.name), ["review"])
})

test("saving refuses sessions that do not exist, listing every missing ID", async () => {
  const { store, memory } = storeDeps({ existing: ["ses_a"] })
  await assert.rejects(
    store.save({ name: "broken", sessionIDs: ["ses_a", "ses_x", "ses_y"] }),
    /ses_x, ses_y/,
  )
  assert.equal(memory.snapshot(), undefined, "nothing is persisted on failure")
})

test("get and remove validate names and only remove what exists", async () => {
  const { store, memory } = storeDeps()
  await store.save({ name: "daily", sessionIDs: ["ses_a"] })
  assert.deepEqual((await store.get(" daily ")).sessionIDs, ["ses_a"])
  assert.equal(await store.get("missing"), undefined)
  assert.deepEqual(await store.remove({ name: "missing" }), { removed: false })
  assert.deepEqual(await store.remove({ name: "daily" }), { removed: true })
  assert.deepEqual(await store.list(), [])
  assert.equal(memory.snapshot().workspaces.daily, undefined)
})

test("saving rewrites the collection without corrupt entries", async () => {
  const storage = memoryStorage({ workspaces: { corrupt: { sessionIDs: [] }, fine: { sessionIDs: ["ses_a"], createdAt: 1, updatedAt: 1 } } })
  const { store } = storeDeps({ storage })
  await store.save({ name: "new", sessionIDs: ["ses_b"] })
  const names = Object.keys(storage.snapshot().workspaces)
  assert.deepEqual(names.sort(), ["fine", "new"])
})

test("resolveExistingSessions partitions saved IDs against the server", async () => {
  const { existing, stale } = await resolveExistingSessions({
    get: async id => {
      if (id === "ses_gone") throw new Error("not found")
    },
    sessionIDs: ["ses_a", "ses_gone", "ses_b"],
  })
  assert.deepEqual(existing, ["ses_a", "ses_b"])
  assert.deepEqual(stale, ["ses_gone"])
})
