import { Rpc } from "@opencode/plugin/rpc"

const string = { type: "string", minLength: 1 }
const sessions = {
  type: "array",
  items: { type: "string", minLength: 4 },
  minItems: 1,
  maxItems: 20,
}

export const openInput = {
  type: "object",
  properties: { sessionIDs: sessions, focus: { type: "boolean" } },
  required: ["sessionIDs"],
  additionalProperties: false,
}

export const SessionTabs = Rpc.define({
  id: "session-tabs",
  methods: {
    open: {
      output: {
        type: "object",
        properties: {
          opened: { type: "array", items: string },
          alreadyOpen: { type: "array", items: string },
          focused: { type: "boolean" },
        },
        required: ["opened", "alreadyOpen", "focused"],
        additionalProperties: false,
      },
      input: {
        type: "object",
        properties: { originSessionID: string, sessionIDs: sessions, focus: { type: "boolean" } },
        required: ["originSessionID", "sessionIDs"],
        additionalProperties: false,
      },
    },
    claim: {
      output: {
        type: "object",
        properties: { claimed: { type: "boolean" } },
        required: ["claimed"],
        additionalProperties: false,
      },
      input: {
        type: "object",
        properties: { requestID: string, clientID: string },
        required: ["requestID", "clientID"],
        additionalProperties: false,
      },
    },
    complete: {
      output: {
        type: "object",
        properties: { accepted: { type: "boolean" } },
        required: ["accepted"],
        additionalProperties: false,
      },
      input: {
        type: "object",
        properties: {
          requestID: string,
          clientID: string,
          opened: { type: "array", items: string },
          alreadyOpen: { type: "array", items: string },
          focused: { type: "boolean" },
          error: { type: "string" },
        },
        required: ["requestID", "clientID", "opened", "alreadyOpen", "focused"],
        additionalProperties: false,
      },
    },
  },
  events: {
    requested: {
      schema: {
        type: "object",
        properties: {
          requestID: string,
          originSessionID: string,
          sessionIDs: sessions,
          focus: { type: "boolean" },
        },
        required: ["requestID", "originSessionID", "sessionIDs", "focus"],
        additionalProperties: false,
      },
    },
  },
})
