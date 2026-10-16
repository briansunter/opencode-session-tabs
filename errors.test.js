import test from "node:test"
import assert from "node:assert/strict"
import { errorMessage } from "./core.js"

// Regression: RPC rejections cross the wire as plain objects (verified wire
// shape from @opencode/client promise types), not Error instances, so
// String(error) rendered "[object Object]" in toasts and dialogs.
test("errorMessage extracts messages from Error instances and direct strings", () => {
  assert.equal(errorMessage(new Error("boom")), "boom")
  assert.equal(errorMessage(new Error("  padded  ")), "padded")
  assert.equal(errorMessage(new TypeError("not a function")), "not a function")
  assert.equal(errorMessage("direct string"), "direct string")
  assert.equal(errorMessage("  trimmed  "), "trimmed")
})

test("errorMessage extracts the message from structured RPC error objects", () => {
  // Wire shapes from @opencode/client promise generated types.
  const rpcError = { _tag: "RpcError", type: "rpc.method_not_found", message: "Method not found: workspaceSave", data: {} }
  assert.equal(errorMessage(rpcError), "Method not found: workspaceSave")
  assert.equal(
    errorMessage({ _tag: "RpcInternalError", type: "rpc.internal", message: "handler crashed" }),
    "handler crashed",
  )
  assert.equal(errorMessage({ _tag: "FileNotFoundError", path: "/tmp/x", message: "file missing" }), "file missing")
  assert.equal(errorMessage({ message: "plain message object" }), "plain message object")
})

test("errorMessage never renders [object Object] or dumps object contents", () => {
  const secret = { token: "sk-super-secret", request: { headers: { authorization: "Bearer x" } } }
  for (const error of [
    { _tag: "RpcError", type: "rpc.internal", message: "stale server", data: secret },
    { message: "failed", ...secret },
    {},
    { data: secret },
    [],
    { message: { nested: secret } },
    { message: "" },
    { message: "   " },
    null,
    undefined,
  ]) {
    const message = errorMessage(error)
    assert.ok(typeof message === "string" && message.length > 0)
    assert.ok(!message.includes("[object Object]"), `no opaque rendering: ${message}`)
    assert.ok(!message.includes("sk-super-secret"), `no secrets leaked: ${message}`)
    assert.ok(!message.includes("Bearer"), `no payload dumped: ${message}`)
  }
})

test("errorMessage falls back to a stable tag, then a generic label", () => {
  assert.equal(errorMessage({ _tag: "RpcError" }), "RpcError (no message).")
  assert.equal(errorMessage({ type: "rpc.timeout" }), "rpc.timeout (no message).")
  assert.equal(errorMessage({ code: "ECONNREFUSED" }), "ECONNREFUSED (no message).")
  assert.equal(errorMessage({}), "Unknown error.")
  assert.equal(errorMessage(null), "Unknown error.")
  assert.equal(errorMessage(undefined), "Unknown error.")
  assert.equal(errorMessage(""), "Unknown error.")
})

test("errorMessage stringifies primitives without object serialization", () => {
  assert.equal(errorMessage(42), "42")
  assert.equal(errorMessage(0), "0")
  assert.equal(errorMessage(false), "false")
  assert.equal(errorMessage(Number.NaN), "NaN")
})
