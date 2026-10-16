// Deterministic fake for the documented dialog API (ui.dialog.select/prompt/
// confirm/alert/clear plus the custom-JSX ui.dialog.show/set surface) used to
// drive modal flows. show/set follow the host DialogProvider contract:
// showing replaces the stack (firing the previous entry's onClose), clear
// fires every onClose, and closeShow simulates the host's dialog Escape
// (onClose, then the entry is gone).
export function fakeDialog() {
  const log = []
  const selects = []
  const prompts = []
  const confirms = []
  const alerts = []
  const shows = []
  const setCalls = []
  let shown = []
  let clearCount = 0
  let waiters = []
  let seen = 0

  const ping = () => {
    const ready = waiters
    waiters = []
    for (const waiter of ready) waiter()
  }
  const record = call => {
    log.push(call)
    ping()
  }
  const promiseCall = (kind, options, bucket) =>
    new Promise(resolve => {
      const call = { kind, options, resolve }
      bucket.push(call)
      record(call)
    })

  const dialog = {
    show: (render, onClose) => {
      for (const item of shown) item.onClose?.()
      shown = [{ render, onClose }]
      shows.push({ render, onClose })
      record({ kind: "show", render, onClose })
    },
    set: options => {
      setCalls.push(options)
    },
    select: options => promiseCall("select", options, selects),
    prompt: options => promiseCall("prompt", options, prompts),
    confirm: options => promiseCall("confirm", options, confirms),
    alert: options => promiseCall("alert", options, alerts),
    clear: () => {
      clearCount++
      for (const item of shown) item.onClose?.()
      shown = []
    },
  }

  const currentSelect = () => selects.at(-1)
  const action = bind => currentSelect().options.actions.find(entry => entry.bind === bind)

  return {
    dialog,
    selects,
    prompts,
    confirms,
    alerts,
    shows,
    setCalls,
    clearCount: () => clearCount,
    currentSelect,
    action,
    currentShow: () => shown.at(-1),
    // Simulates the host's dialog Escape: the active show entry's onClose
    // fires and the entry is popped, exactly as DialogProvider does.
    closeShow() {
      const item = shown.pop()
      item?.onClose?.()
    },
    // Resolves with the newest dialog call once it exists.
    async next() {
      if (log.length > seen) {
        seen = log.length
        return log.at(-1)
      }
      await new Promise(resolve => waiters.push(resolve))
      seen = log.length
      return log.at(-1)
    },
    // Enter on the highlighted option (select) or a submitted value (prompt).
    submit(value) {
      currentSelect().resolve(value)
    },
    answerPrompt(value) {
      prompts.at(-1).resolve(value)
    },
    answerConfirm(value) {
      confirms.at(-1).resolve(value)
    },
    closeAlert() {
      alerts.at(-1).resolve(undefined)
    },
    escape() {
      currentSelect().resolve(undefined)
    },
    // Runs a footer action exactly as the host would: invoke, then resolve the
    // select promise with undefined because the action cleared the dialog.
    trigger(bind, value) {
      const entry = action(bind)
      if (!entry) throw new Error(`no action bound to ${bind}`)
      entry.onTrigger(value)
      currentSelect().resolve(undefined)
    },
  }
}
