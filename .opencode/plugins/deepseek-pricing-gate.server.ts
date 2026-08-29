import type { Plugin } from "@opencode-ai/plugin"

import {
  CONFIRMATION_TIMEOUT_MS,
  DECISION_COMMAND_PREFIX,
  DEEPSEEK_PROVIDER_ID,
  REQUEST_COMMAND_PREFIX,
  type ConfirmationDecision,
  type ConfirmationRequest,
  decodeCommandPayload,
  encodeCommandPayload,
  isConfirmationDecision,
  isPeakUtc,
  isSupportedModel,
  pricingForModel,
} from "../deepseek-pricing-gate.shared.js"

type ObservedMessage = {
  sessionID: string
  providerID: string
  modelID: string
}

type ConfirmationFailureCode = "unavailable" | "timeout" | "session-deleted" | "disposed"

class ConfirmationFailure extends Error {
  constructor(readonly code: ConfirmationFailureCode) {
    super(code)
    this.name = "ConfirmationFailure"
  }
}

type PendingConfirmation = {
  request: ConfirmationRequest
  promise: Promise<boolean>
  resolve: (allow: boolean) => void
  reject: (error: ConfirmationFailure) => void
  settled: boolean
  timer?: ReturnType<typeof setTimeout>
}

export default (async ({ client, directory }) => {
  const observedMessages = new Map<string, ObservedMessage>()
  const messageIDsBySession = new Map<string, Set<string>>()
  const approvedSessions = new Set<string>()
  const pendingBySession = new Map<string, Promise<boolean>>()
  const pendingByNonce = new Map<string, PendingConfirmation>()

  function settlePending(pending: PendingConfirmation, allow?: boolean, error?: ConfirmationFailure): void {
    if (pending.settled) return

    pending.settled = true
    if (pending.timer) clearTimeout(pending.timer)
    pendingByNonce.delete(pending.request.nonce)
    if (pendingBySession.get(pending.request.sessionID) === pending.promise) {
      pendingBySession.delete(pending.request.sessionID)
    }

    if (error) pending.reject(error)
    else pending.resolve(allow === true)
  }

  function sendRequest(pending: PendingConfirmation): void {
    void (async () => {
      try {
        const command = `${REQUEST_COMMAND_PREFIX}${encodeCommandPayload(pending.request)}`
        const result = await client.tui.publish({
          body: {
            type: "tui.command.execute",
            properties: { command },
          },
          query: { directory },
        })
        if (result.error !== undefined) throw new Error("TUI command was not accepted")
      } catch {
        settlePending(pending, undefined, new ConfirmationFailure("unavailable"))
      }
    })()
  }

  function requestConfirmation(request: ConfirmationRequest): Promise<boolean> {
    const existing = pendingBySession.get(request.sessionID)
    if (existing) return existing

    let resolvePromise!: (allow: boolean) => void
    let rejectPromise!: (error: ConfirmationFailure) => void
    const promise = new Promise<boolean>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    const pending: PendingConfirmation = {
      request,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      settled: false,
    }

    pendingBySession.set(request.sessionID, promise)
    pendingByNonce.set(request.nonce, pending)
    pending.timer = setTimeout(() => {
      settlePending(pending, undefined, new ConfirmationFailure("timeout"))
    }, CONFIRMATION_TIMEOUT_MS)
    sendRequest(pending)
    return promise
  }

  function handleDecision(command: string): void {
    if (!command.startsWith(DECISION_COMMAND_PREFIX)) return

    let value: unknown
    try {
      value = decodeCommandPayload(command.slice(DECISION_COMMAND_PREFIX.length))
    } catch {
      return
    }
    if (!isConfirmationDecision(value)) return

    const decision = value as ConfirmationDecision
    const pending = pendingByNonce.get(decision.nonce)
    if (!pending || pending.settled) return
    if (pending.request.sessionID !== decision.sessionID) return
    if (pending.request.modelID !== decision.modelID) return

    settlePending(pending, decision.allow)
  }

  function clearSession(sessionID: string, failure?: ConfirmationFailure): void {
    approvedSessions.delete(sessionID)

    const messageIDs = messageIDsBySession.get(sessionID)
    if (messageIDs) {
      for (const messageID of messageIDs) observedMessages.delete(messageID)
      messageIDsBySession.delete(sessionID)
    }

    const promise = pendingBySession.get(sessionID)
    if (promise && failure) {
      for (const pending of pendingByNonce.values()) {
        if (pending.promise === promise) {
          settlePending(pending, undefined, failure)
          break
        }
      }
    }
  }

  function confirmationError(error: unknown): Error {
    if (!(error instanceof ConfirmationFailure)) {
      return new Error("DeepSeek peak-pricing confirmation failed. No model request was sent.")
    }

    switch (error.code) {
      case "unavailable":
        return new Error(
          "DeepSeek peak-pricing confirmation is unavailable because no TUI is attached. No model request was sent.",
        )
      case "timeout":
        return new Error(
          "DeepSeek peak-pricing confirmation timed out or returned no valid response. No model request was sent.",
        )
      case "session-deleted":
        return new Error("The OpenCode session was deleted before DeepSeek peak-pricing confirmation. No model request was sent.")
      case "disposed":
        return new Error("DeepSeek peak-pricing confirmation is no longer available. No model request was sent.")
    }
  }

  return {
    "chat.message": async (input, output) => {
      const message = output.message
      const model = input.model ?? message.model
      if (message.sessionID !== input.sessionID) return
      if (model.providerID !== DEEPSEEK_PROVIDER_ID || !isSupportedModel(model.modelID)) return

      observedMessages.set(message.id, {
        sessionID: input.sessionID,
        providerID: model.providerID,
        modelID: model.modelID,
      })
      const messageIDs = messageIDsBySession.get(input.sessionID) ?? new Set<string>()
      messageIDs.add(message.id)
      messageIDsBySession.set(input.sessionID, messageIDs)
    },

    "chat.params": async (input) => {
      const providerID = input.model.providerID
      const modelID = input.model.id
      if (providerID !== DEEPSEEK_PROVIDER_ID || !isSupportedModel(modelID)) return
      if (!isPeakUtc(new Date())) return

      const observed = observedMessages.get(input.message.id)
      if (observed && observed.sessionID !== input.sessionID) {
        throw new Error("DeepSeek peak-pricing request message/session mismatch. No model request was sent.")
      }
      if (approvedSessions.has(input.sessionID)) return

      const pricing = pricingForModel(modelID)
      if (!pricing) return

      const request: ConfirmationRequest = {
        nonce: globalThis.crypto.randomUUID(),
        sessionID: input.sessionID,
        modelID,
        pricing,
      }

      let allowed: boolean
      try {
        allowed = await requestConfirmation(request)
      } catch (error) {
        throw confirmationError(error)
      }
      if (!allowed) {
        throw new Error(
          "DeepSeek peak-pricing confirmation was cancelled. No model request was sent. The next submission will require confirmation again unless this session is approved.",
        )
      }

      // A request can cross the end of a peak window while the dialog is open.
      approvedSessions.add(input.sessionID)
      if (!isPeakUtc(new Date())) return
    },

    event: async ({ event }) => {
      if (event.type === "tui.command.execute") handleDecision(event.properties.command)
      if (event.type === "session.deleted") clearSession(event.properties.info.id, new ConfirmationFailure("session-deleted"))
    },

    dispose: async () => {
      for (const pending of pendingByNonce.values()) {
        settlePending(pending, undefined, new ConfirmationFailure("disposed"))
      }
      observedMessages.clear()
      messageIDsBySession.clear()
      approvedSessions.clear()
      pendingBySession.clear()
      pendingByNonce.clear()
    },
  }
}) satisfies Plugin
