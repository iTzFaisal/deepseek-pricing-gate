import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

import {
  DECISION_COMMAND_PREFIX,
  PLUGIN_ID,
  REQUEST_COMMAND_PREFIX,
  type ConfirmationDecision,
  type ConfirmationRequest,
  decodeCommandPayload,
  encodeCommandPayload,
  isConfirmationRequest,
} from "../deepseek-pricing-gate.shared.js"

function formatRate(rate: number): string {
  return `$${rate.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}`
}

export function formatConfirmation(request: ConfirmationRequest): string {
  const { offPeak, peak } = request.pricing
  return [
    `Model: ${request.modelID}`,
    "",
    "This DeepSeek request is being sent during peak hours.",
    "Peak hours (UTC):",
    ...request.pricing.peakWindows.map((window) => `  ${window}`),
    "",
    "Peak rates are exactly 2x off-peak rates.",
    "Rates per 1M tokens (USD):",
    `  Cache-hit input: ${formatRate(offPeak.cacheHit)} off-peak / ${formatRate(peak.cacheHit)} peak`,
    `  Cache-miss input: ${formatRate(offPeak.cacheMiss)} off-peak / ${formatRate(peak.cacheMiss)} peak`,
    `  Output:          ${formatRate(offPeak.output)} off-peak / ${formatRate(peak.output)} peak`,
    "",
    "The exact request cost cannot be calculated before token counts and cache status are known.",
    "",
    "Proceed to send this request?",
  ].join("\n")
}

const tui: TuiPlugin = async (api) => {
  const queue: ConfirmationRequest[] = []
  const received = new Map<string, ConfirmationRequest>()
  let active: ConfirmationRequest | undefined
  let disposed = false

  function clearDialog(): void {
    try {
      api.ui.dialog.clear()
    } catch {
      // The host may already have disposed its dialog stack.
    }
  }

  async function publishDecision(request: ConfirmationRequest, allow: boolean): Promise<void> {
    const decision: ConfirmationDecision = {
      nonce: request.nonce,
      sessionID: request.sessionID,
      modelID: request.modelID,
      allow,
    }
    const command = `${DECISION_COMMAND_PREFIX}${encodeCommandPayload(decision)}`
    const parameters: { command: string; directory?: string } = {
      command,
    }
    if (api.state.path.directory) parameters.directory = api.state.path.directory
    const result = await api.client.tui.publish({
      directory: parameters.directory,
      body: {
        type: "tui.command.execute",
        properties: { command: parameters.command },
      },
    })
    if (result.error !== undefined) throw new Error("TUI decision was not accepted")
  }

  function complete(request: ConfirmationRequest, allow: boolean): void {
    if (disposed || active?.nonce !== request.nonce) return

    active = undefined
    received.delete(request.nonce)
    clearDialog()
    void publishDecision(request, allow)
      .catch(() => {
        api.ui.toast({
          variant: "error",
          title: "DeepSeek pricing gate",
          message: "The pricing decision could not be delivered. The model request will be blocked.",
        })
      })
      .finally(showNext)
  }

  function showNext(): void {
    if (disposed || active || queue.length === 0) return

    const request = queue.shift()
    if (!request) return
    active = request

    try {
      api.ui.dialog.replace(
        () =>
          api.ui.DialogConfirm({
            title: "DeepSeek peak pricing confirmation",
            message: formatConfirmation(request),
            onConfirm: () => complete(request, true),
            onCancel: () => complete(request, false),
          }),
        () => complete(request, false),
      )
    } catch {
      complete(request, false)
    }
  }

  const unsubscribe = api.event.on("tui.command.execute", (event) => {
    const command = event.properties.command
    const encoded = command.startsWith(REQUEST_COMMAND_PREFIX)
      ? command.slice(REQUEST_COMMAND_PREFIX.length)
      : undefined
    if (!encoded) return

    let value: unknown
    try {
      value = decodeCommandPayload(encoded)
    } catch {
      return
    }
    if (!isConfirmationRequest(value)) return
    if (received.has(value.nonce)) return

    received.set(value.nonce, value)
    queue.push(value)
    showNext()
  })

  api.lifecycle.onDispose(() => {
    disposed = true
    unsubscribe()
    queue.length = 0
    received.clear()
    active = undefined
    clearDialog()
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: PLUGIN_ID,
  tui,
}

export default plugin
