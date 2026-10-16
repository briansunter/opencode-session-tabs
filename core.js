import { randomUUID } from "node:crypto"

// ---------------------------------------------------------------------------
// Error rendering. Rejections that cross an RPC boundary arrive as plain
// objects (e.g. { _tag: "RpcError", type, message, data }), not Error
// instances, so String(error) renders "[object Object]". Extract only
// known-safe string fields; the rest of the object is never serialized —
// an RpcError's `data` payload can carry request contents that must not
// be dumped into a toast or dialog.
// ---------------------------------------------------------------------------
export function errorMessage(error) {
  if (typeof error === "string") return error.trim() || "Unknown error."
  if (error !== null && typeof error === "object") {
    const message = typeof error.message === "string" ? error.message.trim() : ""
    if (message) return message
    const tag = ["_tag", "type", "code"].find(field => typeof error[field] === "string" && error[field].trim())
    return tag ? `${error[tag].trim()} (no message).` : "Unknown error."
  }
  if (error === undefined || error === null) return "Unknown error."
  return String(error) || "Unknown error."
}

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

// A child/subagent session carries a truthy string parentID; roots leave the
// field absent, null, or empty (the OpenCode client resolves roots the same
// way, walking `while (parentID)`). Child sessions render inside their
// parent's tab — they are not tabs of their own.
export function isChildSession(session) {
  return typeof session?.parentID === "string" && session.parentID !== ""
}

// Rejects child/subagent sessions before a single tab is opened. The whole
// batch fails with the parent named instead of being silently normalized to
// the parent ID: the caller's result must stay accurate about exactly the
// IDs it requested. Feature-checked because older hosts (and test doubles)
// may not expose the cached session getter.
function rejectChildSessions(context, ids) {
  const get = context?.data?.session?.get
  if (typeof get !== "function") return
  for (const id of ids) {
    const info = get.call(context.data.session, id)
    if (isChildSession(info)) {
      throw new Error(
        `${id} is a child session. Open parent ${info.parentID} instead; child sessions appear inside parent. No tabs were opened.`,
      )
    }
  }
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
  // Children are not tabs: reject them after the preload (which fills the
  // cache the getter reads) but before any tab is opened.
  rejectChildSessions(context, ids)
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
    return { opened, alreadyOpen, focused: false, error: errorMessage(error) }
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
        outcome = { opened: [], alreadyOpen: [], focused: false, error: errorMessage(error) }
      }
      await rpc.complete({ requestID: input.requestID, clientID, ...outcome }, options)
    } catch {
      // RPC/source failures must not reject the callback and kill its listener.
      context.ui.toast.show({ message: "Session-tabs request failed; no success was reported.", variant: "error" })
    }
  })
  return () => { disposed = true; stop() }
}

// ---------------------------------------------------------------------------
// Saved session sets ("workspaces"): durable named lists of session IDs.
// Storage lives with the server plugin (ctx.storage); every record is
// revalidated on read so corrupt data degrades to "missing", never to a crash.
// ---------------------------------------------------------------------------

export function validateWorkspaceName(name) {
  if (typeof name !== "string") throw new Error("Workspace name must be a string.")
  const trimmed = name.trim()
  if (!trimmed) throw new Error("Workspace name cannot be empty.")
  if (trimmed.length > 64) throw new Error("Workspace name must be at most 64 characters.")
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new Error("Workspace name cannot contain control characters.")
  return trimmed
}

function workspaceTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

// Returns the valid records, sorted by most recently updated. Individual
// corrupt entries are skipped; the next save rewrites clean data.
export function normalizeWorkspaceCollection(value) {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return []
  const list = []
  for (const [name, record] of Object.entries(value)) {
    try {
      if (!record || typeof record !== "object") continue
      const sessionIDs = validateSessionIDs(record.sessionIDs)
      const createdAt = workspaceTimestamp(record.createdAt)
      const updatedAt = workspaceTimestamp(record.updatedAt)
      if (createdAt === undefined || updatedAt === undefined) continue
      list.push({ name: validateWorkspaceName(name), sessionIDs, createdAt, updatedAt })
    } catch {
      // Skip the corrupt entry; saving later rewrites the collection without it.
    }
  }
  return list.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function createWorkspaceStore({ read, write, exists, now = () => Date.now() }) {
  async function collection() {
    const raw = await read()
    const map = raw && typeof raw === "object" && !Array.isArray(raw) && raw.workspaces !== undefined
      ? raw.workspaces
      : raw
    return normalizeWorkspaceCollection(map)
  }
  async function persist(list) {
    const map = {}
    for (const workspace of list) {
      map[workspace.name] = {
        sessionIDs: workspace.sessionIDs,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      }
    }
    await write({ workspaces: map })
  }
  return {
    async list() {
      return collection()
    },
    async get(name) {
      const clean = validateWorkspaceName(name)
      return (await collection()).find(workspace => workspace.name === clean)
    },
    async save({ name, sessionIDs }, { signal } = {}) {
      const clean = validateWorkspaceName(name)
      const ids = validateSessionIDs(sessionIDs)
      signal?.throwIfAborted()
      // Refuse to save sessions that do not exist; a saved set must be openable.
      const missing = []
      for (const id of ids) {
        if (!(await exists(id, signal))) missing.push(id)
      }
      if (missing.length) {
        throw new Error(`Cannot save set "${clean}": ${missing.length} session(s) no longer exist: ${missing.join(", ")}.`)
      }
      signal?.throwIfAborted()
      const list = await collection()
      const previous = list.find(workspace => workspace.name === clean)
      const record = {
        name: clean,
        sessionIDs: ids,
        createdAt: previous?.createdAt ?? now(),
        updatedAt: now(),
      }
      await persist([...list.filter(workspace => workspace.name !== clean), record])
      return record
    },
    async remove({ name }) {
      const clean = validateWorkspaceName(name)
      const list = await collection()
      if (!list.some(workspace => workspace.name === clean)) return { removed: false }
      await persist(list.filter(workspace => workspace.name !== clean))
      return { removed: true }
    },
  }
}

// Checks each saved ID against the authoritative server; missing sessions are
// reported instead of opened, so stale sets degrade gracefully.
export async function resolveExistingSessions({ get, sessionIDs }) {
  const existing = []
  const stale = []
  for (const sessionID of sessionIDs) {
    try {
      await get(sessionID)
      existing.push(sessionID)
    } catch {
      stale.push(sessionID)
    }
  }
  return { existing, stale }
}

// ---------------------------------------------------------------------------
// Global session discovery. The TUI's data.session.list() cache only holds
// sessions this particular UI has already loaded, so the picker asks the
// server directly through client.session.list. Scope is deliberately global:
// passing no directory/project/subpath filter returns every session the
// connected server manages, across all locations and projects — the picker
// exists to open cross-directory tabs. Child/subagent sessions are filtered
// out client-side (truthy string parentID): tabs are roots only, and the
// server's parentID filter is not relied upon because its null/undefined
// semantics are ambiguous — a wrong guess would either drop roots or show an
// empty list. Pages follow the documented cursor contract
// ({ data, cursor: { next } }) and are capped so a server that keeps
// returning cursors cannot loop forever; entries are deduplicated by ID so a
// repeating page also stays bounded.
// ---------------------------------------------------------------------------

const DISCOVER_PAGE_SIZE = 100
const DISCOVER_MAX_PAGES = 10

/**
 * Discovers top-level (root) sessions globally through cursor-paginated
 * `client.session.list` calls; child/subagent sessions (truthy string
 * `parentID`) are excluded because they appear inside their parent's tab,
 * not as tabs of their own. Newest-first pages, up to `pageSize` * `maxPages`
 * sessions (1000 by default); `truncated` reports that the cap cut the list
 * short. Pages that contain only children still advance the cursor, so roots
 * on later pages are never lost.
 *
 * @param {{
 *   list: (input: { limit?: number, order?: "asc" | "desc", cursor?: string }, requestOptions?: { signal?: AbortSignal }) => Promise<{ data?: Array<Record<string, unknown> & { id: string }>, cursor?: { next?: string | null } }>,
 *   pageSize?: number,
 *   maxPages?: number,
 *   signal?: AbortSignal,
 * }} [options]
 * @returns {Promise<{ sessions: Array<Record<string, unknown> & { id: string }>, pages: number, truncated: boolean }>}
 */
export async function discoverSessions({ list, pageSize = DISCOVER_PAGE_SIZE, maxPages = DISCOVER_MAX_PAGES, signal } = {}) {
  if (typeof list !== "function") throw new Error("A client session list function is required for discovery.")
  if (!Number.isInteger(pageSize) || pageSize < 1 || !Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error("Discovery pageSize and maxPages must be positive integers.")
  }
  const sessions = []
  const seen = new Set()
  let cursor
  let more = false
  let pages = 0
  while (pages < maxPages) {
    const input = { limit: pageSize, order: "desc" }
    if (cursor !== undefined) input.cursor = cursor
    // Page failures reject: callers must report them instead of silently
    // showing a partial list as if it were complete.
    const page = await list(input, { signal })
    pages += 1
    const data = Array.isArray(page?.data) ? page.data : []
    for (const session of data) {
      if (!session || typeof session.id !== "string" || seen.has(session.id)) continue
      // Roots only: children live inside their parent's tab, and opening a
      // child ID can never produce the tab the user expects.
      if (isChildSession(session)) continue
      seen.add(session.id)
      sessions.push(session)
    }
    const next = typeof page?.cursor?.next === "string" && page.cursor.next ? page.cursor.next : undefined
    if (next === undefined || data.length === 0) {
      more = false
      break
    }
    cursor = next
    more = true
  }
  return { sessions, pages, truncated: more }
}

// ---------------------------------------------------------------------------
// Session previews: summaries, relative times, recent message text, search,
// and a race-safe preview loader. All pure over documented SessionInfo and
// SessionMessageInfo shapes.
// ---------------------------------------------------------------------------

export function formatRelativeTime(now, then) {
  if (typeof then !== "number" || !Number.isFinite(then) || then <= 0) return "unknown"
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 45) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  const date = new Date(then)
  const label = `${months[date.getMonth()]} ${date.getDate()}`
  return date.getFullYear() === new Date(now).getFullYear() ? label : `${label}, ${date.getFullYear()}`
}

/**
 * Builds display summaries for the picker: newest first, with titles,
 * directories (shortened through formatPath), relative update times, and a
 * tab-open flag per session.
 *
 * @param {readonly Record<string, unknown>[]} sessions
 * @param {{ now?: number, openIDs?: string[], formatPath?: (value: string) => string }} [options]
 * @returns {Array<{ id: string, title: string, directory: string, updated: string, open: boolean, preview?: string }>}
 */
export function summarizeSessions(sessions, { now, openIDs = [], formatPath = value => value } = {}) {
  const open = new Set(openIDs)
  return sessions
    .map(session => {
      const rawDirectory = session?.location?.directory ?? session?.directory ?? ""
      const directory = typeof rawDirectory === "string" && rawDirectory ? formatPath(rawDirectory) : ""
      return {
        id: session?.id,
        title: (typeof session?.title === "string" && session.title.trim()) || "Untitled session",
        directory,
        category: directory ? directory.split("/").filter(Boolean).at(-1) : "",
        updated: formatRelativeTime(now, session?.time?.updated),
        updatedMs: typeof session?.time?.updated === "number" && Number.isFinite(session.time.updated)
          ? session.time.updated
          : 0,
        open: open.has(session?.id),
      }
    })
    .sort((left, right) => right.updatedMs - left.updatedMs)
}

function clip(text, limit) {
  const collapsed = text.replace(/\s+/g, " ").trim()
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1).trimEnd()}…` : collapsed
}

// Last user prompt and last assistant text, each on one line.
export function recentSessionText(messages, { maxChars = 220 } = {}) {
  if (!Array.isArray(messages)) return ""
  let user
  let assistant
  for (let index = messages.length - 1; index >= 0 && (!user || !assistant); index--) {
    const message = messages[index]
    if (!assistant && message?.type === "assistant") {
      const text = Array.isArray(message.content)
        ? message.content.filter(part => part?.type === "text").map(part => part.text).join(" ").trim()
        : ""
      if (text) assistant = text
    } else if (!user && message?.type === "user") {
      const text = typeof message?.text === "string" ? message.text.trim() : ""
      if (text) user = text
    }
  }
  const limit = Math.max(40, Math.floor(maxChars / 2))
  return [
    user ? `You: ${clip(user, limit)}` : "",
    assistant ? `Agent: ${clip(assistant, limit)}` : "",
  ].filter(Boolean).join("\n")
}

/**
 * Every whitespace-separated term must match title, directory, id, or any
 * preview text loaded so far. Case-insensitive.
 *
 * @param {unknown} query
 * @param {Array<{ id: string, title: string, directory: string, updated?: string, open?: boolean, preview?: string }>} summaries
 * @returns {Array<{ id: string, title: string, directory: string, updated?: string, open?: boolean, preview?: string }>}
 */
export function filterSessions(query, summaries) {
  const terms = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return summaries
  return summaries.filter(summary => {
    const haystack = `${summary.title ?? ""}\n${summary.directory ?? ""}\n${summary.id ?? ""}\n${summary.preview ?? ""}`.toLowerCase()
    return terms.every(term => haystack.includes(term))
  })
}

// Only the most recently started load may cache and report; slower, older
// loads resolve to null so a fast-moving cursor never shows stale previews.
export function createPreviewLoader({ load }) {
  let generation = 0
  const cache = new Map()
  return {
    peek(sessionID) {
      return cache.get(sessionID)
    },
    async load(sessionID) {
      const cached = cache.get(sessionID)
      if (cached !== undefined) return cached
      const token = ++generation
      let text = ""
      try {
        text = await load(sessionID)
      } catch {
        text = ""
      }
      if (token !== generation) return null
      const value = typeof text === "string" ? text.trim() : ""
      if (value) cache.set(sessionID, value)
      return value
    },
  }
}

/**
 * Builds the preview-text loader: the TUI data cache is keyed by sessionID and
 * serves sessions from any location (message.sync/message.list take no
 * location), so it is tried first; a direct client message fetch backs it up
 * when that path fails or holds nothing — e.g. a cross-location session this
 * TUI never loaded. Both return the same SessionMessageInfo wire shape.
 *
 * @param {{
 *   sync: (sessionID: string) => Promise<void>,
 *   cached: (sessionID: string) => Array<Record<string, unknown>>,
 *   listMessages: (sessionID: string) => Promise<{ data?: Array<Record<string, unknown>> }>,
 * }} sources
 * @returns {(sessionID: string) => Promise<string>}
 */
export function createPreviewSource({ sync, cached, listMessages }) {
  return async sessionID => {
    let messages
    try {
      await sync(sessionID)
      messages = cached(sessionID)
    } catch {
      messages = undefined
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      const page = await listMessages(sessionID)
      messages = Array.isArray(page?.data) ? page.data : []
    }
    return recentSessionText(messages)
  }
}

export function createSelection(iterable = []) {
  const selected = new Set(iterable)
  return {
    has: id => selected.has(id),
    toggle(id) {
      if (selected.has(id)) selected.delete(id)
      else selected.add(id)
    },
    addMany(ids) {
      for (const id of ids) selected.add(id)
    },
    removeMany(ids) {
      for (const id of ids) selected.delete(id)
    },
    clear() {
      selected.clear()
    },
    count: () => selected.size,
    ids: () => [...selected],
  }
}

// Shared name prompt for saving a set: validates, confirms overwrites, and
// retries on invalid names. Returns { status: "saved", name } or { status: "cancelled" }.
export async function promptAndSaveWorkspace({ dialog, toast, listWorkspaceNames, save, sessionIDs, suggestedName }) {
  let taken = []
  try {
    taken = (await listWorkspaceNames()) ?? []
  } catch {
    // Listing is best-effort; saving still validates on the server.
  }
  while (true) {
    const name = await dialog.prompt({
      title: "Save session set",
      description: `${sessionIDs.length} session(s) will be saved${taken.length ? `. Existing sets: ${taken.join(", ")}` : ""}.`,
      placeholder: "set name",
      value: suggestedName,
    })
    if (name === undefined) return { status: "cancelled" }
    let clean
    try {
      clean = validateWorkspaceName(name)
    } catch (error) {
      await dialog.alert({ title: "Invalid set name", message: errorMessage(error) })
      continue
    }
    if (taken.includes(clean)) {
      const overwrite = await dialog.confirm({
        title: "Overwrite set",
        message: `A saved set named "${clean}" already exists. Overwrite it?`,
        label: { confirm: "Overwrite", cancel: "Rename" },
      })
      if (overwrite === false) continue
      if (overwrite === undefined) return { status: "cancelled" }
    }
    try {
      const record = await save(clean, sessionIDs)
      toast?.({ message: `Saved session set "${clean}" (${record.sessionIDs.length} session(s)).`, variant: "success" })
      return { status: "saved", name: clean }
    } catch (error) {
      await dialog.alert({ title: "Could not save set", message: errorMessage(error) })
    }
  }
}

export function singleLine(text, limit) {
  return clip(text.split("\n").join(" "), limit)
}

function toastForOpen(toast, label, result, focus, staleCount) {
  const opened = result.opened?.length ?? 0
  const already = result.alreadyOpen?.length ?? 0
  if (result.error) {
    toast({
      message: `${label}: opened ${opened} tab(s), but OpenCode reported: ${result.error}`,
      variant: "warning",
    })
    return
  }
  const parts = [`opened ${opened}`]
  if (already) parts.push(`${already} already open`)
  if (staleCount) parts.push(`${staleCount} stale skipped`)
  toast({
    message: `${label}: ${parts.join(", ")}${focus ? ", focused the last tab" : ""}.`,
    variant: "success",
  })
}

export async function runOpenTabs(openTabs, toast, label, sessionIDs, { focus = false, staleCount = 0 } = {}) {
  try {
    const result = await openTabs(sessionIDs, { focus })
    toastForOpen(toast, label, result, focus, staleCount)
    return { status: result.error ? "error" : "opened", ...result, focused: focus && !result.error }
  } catch (error) {
    const message = errorMessage(error)
    toast({ message: `${label}: ${message}`, variant: "error" })
    return { status: "error", message, opened: [], alreadyOpen: [], focused: false }
  }
}

// ---------------------------------------------------------------------------
// Batch-open modal. The interactive picker lives in picker.tsx: it renders a
// custom-JSX dialog through the documented ui.dialog.show API with reactive
// Solid state, so the search input, query, highlight, selection, and inline
// preview survive toggles, previews, nested save-set dialogs, and re-shows.
// The workspace manager below stays on the promise-based dialog.select API.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Workspace manager: open, prune, delete, and save sets of sessions. Enter
// opens the highlighted set in background tabs; ctrl+f focuses the last tab.
// ---------------------------------------------------------------------------
export async function runWorkspaceManager(deps) {
  const {
    dialog,
    toast,
    listWorkspaces,
    saveWorkspace,
    removeWorkspace,
    getSession,
    sessionTitle = () => undefined,
    openTabs,
    openTabIDs = () => [],
    now = () => Date.now(),
    tabsEnabled,
  } = deps
  if (typeof tabsEnabled === "function" && !tabsEnabled()) {
    toast({ message: "Session tabs are disabled. Enable them in OpenCode settings first.", variant: "error" })
    return { status: "cancelled" }
  }
  let highlighted

  const loadSets = async () => {
    const { workspaces } = await listWorkspaces()
    return [...(Array.isArray(workspaces) ? workspaces : [])].sort((left, right) => right.updatedAt - left.updatedAt)
  }

  const describeSet = set => {
    const titles = set.sessionIDs.map(id => sessionTitle(id)?.trim() || id)
    const preview = titles.slice(0, 3).join(", ") + (titles.length > 3 ? `, +${titles.length - 3} more` : "")
    return `${set.sessionIDs.length} session(s) · updated ${formatRelativeTime(now(), set.updatedAt)} · ${preview}`
  }

  const openSetWith = async (set, focus) => {
    const { existing, stale } = await resolveExistingSessions({ get: getSession, sessionIDs: set.sessionIDs })
    if (!stale.length) return runOpenTabs(openTabs, toast, `Set "${set.name}"`, existing, { focus })
    if (!existing.length) {
      await dialog.alert({
        title: `Set "${set.name}" is stale`,
        message: `Every saved session no longer exists:\n${stale.join(", ")}\n\nPrune (ctrl+r) or delete (ctrl+d) the set instead.`,
      })
      return { status: "cancelled" }
    }
    const proceed = await dialog.confirm({
      title: "Stale sessions in set",
      message: `${stale.length} saved session(s) no longer exist and will be skipped:\n${stale.join(", ")}\n\nOpen the remaining ${existing.length}?`,
      label: { confirm: `Open ${existing.length}`, cancel: "Back" },
    })
    if (!proceed) return { status: "cancelled" }
    return runOpenTabs(openTabs, toast, `Set "${set.name}"`, existing, { focus, staleCount: stale.length })
  }

  const pruneSet = async set => {
    const { existing, stale } = await resolveExistingSessions({ get: getSession, sessionIDs: set.sessionIDs })
    if (!stale.length) {
      toast({ message: `Set "${set.name}" has no stale sessions.`, variant: "info" })
      return
    }
    if (!existing.length) {
      const remove = await dialog.confirm({
        title: "Empty set",
        message: `Every session in "${set.name}" is gone. Delete the set?`,
        label: { confirm: "Delete", cancel: "Back" },
      })
      if (!remove) return
      try {
        await removeWorkspace(set.name)
        toast({ message: `Deleted empty set "${set.name}".`, variant: "success" })
      } catch (error) {
        toast({ message: errorMessage(error), variant: "error" })
      }
      return
    }
    const confirm = await dialog.confirm({
      title: "Remove stale sessions",
      message: `Remove ${stale.length} missing session(s) from "${set.name}", keeping ${existing.length}?`,
      label: { confirm: "Remove", cancel: "Back" },
    })
    if (!confirm) return
    try {
      await saveWorkspace(set.name, existing)
      toast({ message: `Updated set "${set.name}": ${existing.length} session(s) remain.`, variant: "success" })
    } catch (error) {
      toast({ message: errorMessage(error), variant: "error" })
    }
  }

  const deleteSet = async set => {
    const confirm = await dialog.confirm({
      title: "Delete set",
      message: `Delete saved set "${set.name}" (${set.sessionIDs.length} session(s))? Sessions and open tabs are not affected.`,
      label: { confirm: "Delete", cancel: "Back" },
    })
    if (!confirm) return
    try {
      const { removed } = await removeWorkspace(set.name)
      toast({
        message: removed ? `Deleted set "${set.name}".` : `Set "${set.name}" was already gone.`,
        variant: removed ? "success" : "info",
      })
    } catch (error) {
      toast({ message: errorMessage(error), variant: "error" })
    }
  }

  const saveTabs = async () => {
    const ids = [...new Set(openTabIDs())]
    if (!ids.length) {
      toast({ message: "No open tabs to save.", variant: "warning" })
      return { status: "cancelled" }
    }
    return promptAndSaveWorkspace({
      dialog,
      toast,
      listWorkspaceNames: async () => (await loadSets()).map(set => set.name),
      save: saveWorkspace,
      sessionIDs: ids,
    })
  }

  while (true) {
    let sets
    try {
      sets = await loadSets()
    } catch (error) {
      const message = errorMessage(error)
      toast({ message: `Could not load saved sets: ${message}`, variant: "error" })
      return { status: "error", message }
    }
    if (!sets.length) {
      await dialog.alert({
        title: "Session workspaces",
        message: "No saved session sets yet.\n\nSave one from the session picker with ctrl+s, or save your open tabs as a set now.",
      })
      return saveTabs()
    }
    let signal = "pending"
    let target
    const value = await dialog.select({
      title: "Session workspaces",
      placeholder: "Search saved sets…",
      current: highlighted,
      options: sets.map(set => ({ title: set.name, value: set.name, description: describeSet(set) })),
      actions: [
        {
          bind: "ctrl+o",
          title: "Open",
          onTrigger: name => {
            highlighted = name
            target = name
            signal = "open"
            dialog.clear()
          },
        },
        {
          bind: "ctrl+f",
          title: "Open & focus",
          onTrigger: name => {
            highlighted = name
            target = name
            signal = "open-focus"
            dialog.clear()
          },
        },
        {
          bind: "ctrl+r",
          title: "Prune stale",
          onTrigger: name => {
            highlighted = name
            target = name
            signal = "prune"
            dialog.clear()
          },
        },
        {
          bind: "ctrl+d",
          title: "Delete",
          onTrigger: name => {
            highlighted = name
            target = name
            signal = "delete"
            dialog.clear()
          },
        },
        {
          bind: "ctrl+s",
          title: "Save open tabs",
          selection: "none",
          onTrigger: () => {
            signal = "save"
            dialog.clear()
          },
        },
      ],
    })
    if (value !== undefined) {
      highlighted = value
      const set = sets.find(item => item.name === value)
      return set ? openSetWith(set, false) : { status: "cancelled" }
    }
    if (signal === "pending") return { status: "cancelled" }
    if (signal === "save") {
      await saveTabs()
      continue
    }
    const set = sets.find(item => item.name === target)
    if (!set) continue
    if (signal === "open") return openSetWith(set, false)
    if (signal === "open-focus") return openSetWith(set, true)
    if (signal === "prune") {
      await pruneSet(set)
      continue
    }
    if (signal === "delete") {
      await deleteSet(set)
      continue
    }
  }
}
