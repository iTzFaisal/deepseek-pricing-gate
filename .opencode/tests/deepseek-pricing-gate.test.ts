import assert from "node:assert/strict"
import { test } from "node:test"

import serverPlugin from "../plugins/deepseek-pricing-gate.server.js"
import tuiPlugin from "../tui/deepseek-pricing-gate.tui.js"
import {
  DECISION_COMMAND_PREFIX,
  DEEPSEEK_PROVIDER_ID,
  PEAK_WINDOWS,
  REQUEST_COMMAND_PREFIX,
  SUPPORTED_MODEL_IDS,
  decodeCommandPayload,
  encodeCommandPayload,
  isConfirmationRequest,
  isPeakUtc,
  pricingForModel,
} from "../deepseek-pricing-gate.shared.js"

test("uses weekday UTC peak windows with half-open boundaries", () => {
  const at = (day: number, hour: number, minute: number, second = 0, millisecond = 0) =>
    new Date(Date.UTC(2026, 7, 24 + day, hour, minute, second, millisecond))

  assert.equal(isPeakUtc(at(0, 0, 59, 59)), false)
  assert.equal(isPeakUtc(at(0, 1, 0)), true)
  assert.equal(isPeakUtc(at(0, 3, 59, 59, 999)), true)
  assert.equal(isPeakUtc(at(0, 4, 0)), false)
  assert.equal(isPeakUtc(at(0, 5, 59, 59, 999)), false)
  assert.equal(isPeakUtc(at(0, 6, 0)), true)
  assert.equal(isPeakUtc(at(0, 9, 59, 59, 999)), true)
  assert.equal(isPeakUtc(at(0, 10, 0)), false)
  assert.equal(isPeakUtc(at(5, 2, 0)), false)
  assert.equal(isPeakUtc(at(6, 2, 0)), false)
})

test("contains all pricing rows and exact 2x peak rates", () => {
  assert.deepEqual(PEAK_WINDOWS, ["Monday-Friday 01:00-04:00 UTC", "Monday-Friday 06:00-10:00 UTC"])

  for (const modelID of SUPPORTED_MODEL_IDS) {
    const pricing = pricingForModel(modelID)
    assert.ok(pricing)
    assert.equal(pricing.multiplier, 2)
    assert.equal(pricing.peak.cacheHit, pricing.offPeak.cacheHit * 2)
    assert.equal(pricing.peak.cacheMiss, pricing.offPeak.cacheMiss * 2)
    assert.equal(pricing.peak.output, pricing.offPeak.output * 2)
  }
})

test("round-trips Unicode command payloads and rejects altered pricing", () => {
  const pricing = pricingForModel("deepseek-v4-flash")
  assert.ok(pricing)
  const request = {
    nonce: "nonce-1",
    sessionID: "session-1",
    modelID: "deepseek-v4-flash",
    pricing,
  }
  const decoded = decodeCommandPayload(encodeCommandPayload(request))
  assert.equal(isConfirmationRequest(decoded), true)

  const altered = structuredClone(request)
  altered.pricing.peak.output = 999
  assert.equal(isConfirmationRequest(altered), false)
})

function withFixedNow<T>(iso: string, callback: () => Promise<T>): Promise<T> {
  const RealDate = globalThis.Date
  const fixedTime = new RealDate(iso).getTime()
  const FixedDate = class extends RealDate {
    constructor(value?: string | number | Date) {
      if (value === undefined) super(fixedTime)
      else if (value instanceof RealDate) super(value.getTime())
      else super(value)
    }

    static now(): number {
      return fixedTime
    }
  }
  globalThis.Date = FixedDate as unknown as DateConstructor

  return callback().finally(() => {
    globalThis.Date = RealDate
  })
}

function params(modelID = "deepseek-v4-flash", providerID = DEEPSEEK_PROVIDER_ID): Record<string, unknown> {
  return {
    sessionID: "session-1",
    agent: "build",
    model: { id: modelID, providerID },
    provider: {},
    message: { id: "message-1", sessionID: "session-1", role: "user" },
  }
}

test("gates a peak request once and retains session approval", async () => {
  await withFixedNow("2026-08-24T02:00:00.000Z", async () => {
    const commands: Array<{
      body: { type: "tui.command.execute"; properties: { command: string } }
      query: { directory: string }
    }> = []
    const hooks = await serverPlugin({
      client: {
        tui: {
          publish: async (options: (typeof commands)[number]) => {
            commands.push(options)
            return { data: true, error: undefined }
          },
        },
      },
      directory: "/project",
    } as never)
    const chatParams = hooks["chat.params"]! as unknown as (input: unknown, output: unknown) => Promise<void>

    const first = chatParams(params(), {})
    const second = chatParams(params(), {})
    assert.equal(commands.length, 1)
    assert.deepEqual(commands[0].query, { directory: "/project" })

    const encodedRequest = commands[0].body.properties.command.slice(REQUEST_COMMAND_PREFIX.length)
    const request = decodeCommandPayload(encodedRequest)
    assert.equal(isConfirmationRequest(request), true)
    assert.ok(request && typeof request === "object" && "nonce" in request)

    await hooks.event!({
      event: {
        type: "tui.command.execute",
        properties: {
          command: `${DECISION_COMMAND_PREFIX}${encodeCommandPayload({
            nonce: request.nonce,
            sessionID: "session-1",
            modelID: "deepseek-v4-flash",
            allow: true,
          })}`,
        },
      },
    })
    await Promise.all([first, second])
    await chatParams(params(), {})
    assert.equal(commands.length, 1)
  })
})

test("fails closed when the TUI command cannot be delivered", async () => {
  await withFixedNow("2026-08-24T02:00:00.000Z", async () => {
    const hooks = await serverPlugin({
      client: {
        tui: {
          publish: async () => {
            throw new Error("not attached")
          },
        },
      },
      directory: "/project",
    } as never)
    const chatParams = hooks["chat.params"]! as unknown as (input: unknown, output: unknown) => Promise<void>

    await assert.rejects(chatParams(params(), {}), /no TUI is attached.*No model request was sent/)
  })
})

test("ignores mismatched decisions and blocks a cancelled request", async () => {
  await withFixedNow("2026-08-24T02:00:00.000Z", async () => {
    const commands: Array<{ body: { properties: { command: string } } }> = []
    const hooks = await serverPlugin({
      client: {
        tui: {
          publish: async (event: (typeof commands)[number]) => {
            commands.push(event)
            return { data: true, error: undefined }
          },
        },
      },
      directory: "/project",
    } as never)
    const chatParams = hooks["chat.params"]! as unknown as (input: unknown, output: unknown) => Promise<void>
    const pending = chatParams(params(), {})
    const request = decodeCommandPayload(commands[0].body.properties.command.slice(REQUEST_COMMAND_PREFIX.length))
    assert.ok(isConfirmationRequest(request))

    await hooks.event!({
      event: {
        type: "tui.command.execute",
        properties: {
          command: `${DECISION_COMMAND_PREFIX}${encodeCommandPayload({
            nonce: request.nonce,
            sessionID: "different-session",
            modelID: request.modelID,
            allow: true,
          })}`,
        },
      },
    })
    let settled = false
    void pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await Promise.resolve()
    assert.equal(settled, false)

    await hooks.event!({
      event: {
        type: "tui.command.execute",
        properties: {
          command: `${DECISION_COMMAND_PREFIX}${encodeCommandPayload({
            nonce: request.nonce,
            sessionID: request.sessionID,
            modelID: request.modelID,
            allow: false,
          })}`,
        },
      },
    })
    await assert.rejects(pending, /cancelled.*next submission will require confirmation again/)
  })
})

test("bypasses off-peak, other providers, and unsupported models", async () => {
  await withFixedNow("2026-08-24T04:00:00.000Z", async () => {
    let calls = 0
    const hooks = await serverPlugin({
      client: {
        tui: {
          publish: async () => {
            calls += 1
            return { data: true, error: undefined }
          },
        },
      },
      directory: "/project",
    } as never)
    const chatParams = hooks["chat.params"]! as unknown as (input: unknown, output: unknown) => Promise<void>

    await chatParams(params(), {})
    await chatParams(params("deepseek-v4-unknown"), {})
    await chatParams(params("deepseek-v4-flash", "openrouter"), {})
    assert.equal(calls, 0)
  })
})

test("renders a validated TUI request and publishes Proceed", async () => {
  const pricing = pricingForModel("deepseek-v4-pro")
  assert.ok(pricing)
  const request = {
    nonce: "nonce-2",
    sessionID: "session-2",
    modelID: "deepseek-v4-pro",
    pricing,
  }
  let eventHandler: ((event: unknown) => void) | undefined
  let disposeHandler: (() => void) | undefined
  let dialog: { render: () => unknown; onClose: () => void } | undefined
  const decisions: Array<{ command: string; directory?: string }> = []

  await tuiPlugin.tui(
    {
      event: {
        on: (_type: string, handler: (event: unknown) => void) => {
          eventHandler = handler
          return () => {
            eventHandler = undefined
          }
        },
      },
      ui: {
        dialog: {
          replace: (render: () => unknown, onClose: () => void) => {
            dialog = { render, onClose }
          },
          clear: () => undefined,
        },
        DialogConfirm: (props: Record<string, unknown>) => props,
        toast: () => undefined,
      },
      state: { path: { directory: "/project" } },
      client: {
        tui: {
          publish: async (event: {
            body: { type: "tui.command.execute"; properties: { command: string } }
            directory?: string
          }) => {
            decisions.push({ command: event.body.properties.command, directory: event.directory })
            return { data: true, error: undefined }
          },
        },
      },
      lifecycle: {
        onDispose: (handler: () => void) => {
          disposeHandler = handler
          return () => undefined
        },
      },
    } as never,
    undefined,
    {} as never,
  )

  eventHandler!({
    type: "tui.command.execute",
    properties: { command: `${REQUEST_COMMAND_PREFIX}${encodeCommandPayload(request)}` },
  })
  assert.ok(dialog)
  const confirm = dialog.render() as { message: string; onConfirm: () => void }
  assert.match(confirm.message, /deepseek-v4-pro/)
  assert.match(confirm.message, /\$0.022 off-peak \/ \$0.044 peak/)
  assert.match(confirm.message, /exactly 2x/)
  confirm.onConfirm()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].directory, "/project")
  const decision = decodeCommandPayload(decisions[0].command.slice(DECISION_COMMAND_PREFIX.length))
  assert.deepEqual(decision, {
    nonce: "nonce-2",
    sessionID: "session-2",
    modelID: "deepseek-v4-pro",
    allow: true,
  })
  disposeHandler!()
})
