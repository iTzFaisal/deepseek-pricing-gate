import serverPlugin from "../plugins/deepseek-pricing-gate.server.js"
import tuiPlugin from "../tui/deepseek-pricing-gate.tui.js"
import {
  DECISION_COMMAND_PREFIX,
  DEEPSEEK_PROVIDER_ID,
  decodeCommandPayload,
} from "../deepseek-pricing-gate.shared.js"

// ---------------------------------------------------------------- fixed clock

function freezeNow(iso: string): () => void {
  const RealDate = globalThis.Date
  const fixedTime = new RealDate(iso).getTime()
  const FixedDate = class extends RealDate {
    constructor(value?: string | number | Date) {
      if (value === undefined) super(fixedTime)
      else if (value instanceof RealDate) super(value.getTime())
      else super(value as never)
    }

    static now(): number {
      return fixedTime
    }
  }
  globalThis.Date = FixedDate as unknown as DateConstructor
  return () => {
    globalThis.Date = RealDate
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const ticks = async (count = 3): Promise<void> => {
  for (let i = 0; i < count; i += 1) await tick()
}

const withTime = async (iso: string, fn: () => Promise<void>): Promise<void> => {
  const unfreeze = freezeNow(iso)
  try {
    await fn()
  } finally {
    unfreeze()
  }
}

// ------------------------------------------------------------------ harness

type DialogState = {
  render: () => { message: string; onConfirm: () => void; onCancel: () => void }
  onClose: () => void
}

function params(
  modelID = "deepseek-v4-flash",
  providerID = DEEPSEEK_PROVIDER_ID,
  sessionID = "session-1",
  messageID = "message-1",
): Record<string, unknown> {
  return {
    sessionID,
    agent: "build",
    model: { id: modelID, providerID },
    provider: {},
    message: { id: messageID, sessionID, role: "user" },
  }
}

async function createHarness(): Promise<{
  chatParams: (input: Record<string, unknown>, output: Record<string, unknown>) => Promise<void>
  getDialog: () => DialogState | undefined
  requestCommands: string[]
  decisionCommands: string[]
}> {
  let dialog: DialogState | undefined
  let tuiHandler: ((event: unknown) => void) | undefined
  let serverHooks: {
    "chat.params": (input: unknown, output: unknown) => Promise<void>
    event: (input: { event: { type: string; properties: { command: string } } }) => Promise<void>
  }
  const requestCommands: string[] = []
  const decisionCommands: string[] = []

  const serverClient = {
    tui: {
      publish: async (options: { body: { type: string; properties: { command: string } }; query: { directory: string } }) => {
        requestCommands.push(options.body.properties.command)
        tuiHandler?.(options.body)
        return { data: true, error: undefined }
      },
    },
  }

  serverHooks = (await serverPlugin({
    client: serverClient,
    directory: "/project",
  } as never)) as unknown as typeof serverHooks

  const tuiApi = {
    event: {
      on: (_type: string, handler: (event: unknown) => void) => {
        tuiHandler = handler
        return () => {
          tuiHandler = undefined
        }
      },
    },
    ui: {
      dialog: {
        replace: (render: () => unknown, onClose: () => void) => {
          dialog = { render: render as DialogState["render"], onClose }
        },
        clear: () => {
          dialog = undefined
        },
      },
      DialogConfirm: (props: Record<string, unknown>) => props,
      toast: () => undefined,
    },
    state: { path: { directory: "/project" } },
    client: {
      tui: {
        publish: async (event: { body: { type: string; properties: { command: string } } }) => {
          decisionCommands.push(event.body.properties.command)
          await serverHooks.event({ event: event.body })
          return { data: true, error: undefined }
        },
      },
    },
    lifecycle: { onDispose: () => undefined },
  }

  await tuiPlugin.tui(tuiApi as never, undefined, {} as never)

  return {
    chatParams: (input, output) => serverHooks["chat.params"](input, output),
    getDialog: () => dialog,
    requestCommands,
    decisionCommands,
  }
}

// ----------------------------------------------------------------- scenario

let failures = 0

async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`PASS  ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL  ${name}`)
    console.log(`      ${(error as Error).message}`)
  }
}

function expectDialog(dialog: DialogState | undefined, contains: string[] = []): DialogState {
  if (!dialog) throw new Error("expected a confirmation dialog but none was shown")
  const rendered = dialog.render()
  if (contains.length > 0) {
    for (const fragment of contains) {
      if (!rendered.message.includes(fragment)) {
        throw new Error(`dialog message missing ${JSON.stringify(fragment)}`)
      }
    }
  }
  return dialog
}

async function expectNoDialog(h: Awaited<ReturnType<typeof createHarness>>, why: string): Promise<void> {
  if (h.getDialog()) throw new Error(`unexpected dialog: ${why}`)
}

// ------------------------------------------------------------------- run

const PEAK_MONDAY = "2026-08-24T02:00:00.000Z"
const OFF_PEAK_MONDAY = "2026-08-24T05:00:00.000Z"
const PEAK_CLOCK_SATURDAY = "2026-08-29T02:00:00.000Z"

await withTime(PEAK_MONDAY, async () => {
  await scenario("peak request opens one dialog; Proceed releases the request", async () => {
    const h = await createHarness()
    const pending = h.chatParams(params(), {})
    await ticks()

    const dialog = expectDialog(h.getDialog(), [
      "Model: deepseek-v4-flash",
      "Peak rates are exactly 2x off-peak rates.",
      "Cache-hit input: $0.007 off-peak / $0.014 peak",
      "Cache-miss input: $0.22 off-peak / $0.44 peak",
      "Output:          $0.66 off-peak / $1.32 peak",
      "Monday-Friday 01:00-04:00 UTC",
      "Proceed to send this request?",
    ])
    console.log()
    console.log("=== dialog shown to the user ===")
    console.log(dialog.render().message)
    console.log("===============================")
    console.log()

    dialog.render().onConfirm()
    await pending
    if (h.requestCommands.length !== 1) throw new Error("expected exactly one request command")
    if (h.decisionCommands.length !== 1) throw new Error("expected exactly one decision command")
  })

  await scenario("Cancel denies the request and no model request is sent", async () => {
    const h = await createHarness()
    const pending = h.chatParams(params(), {})
    await ticks()
    expectDialog(h.getDialog()).render().onCancel()

    await assertRejects(pending, /cancelled.*No model request was sent/)
    if (h.decisionCommands.length !== 1) throw new Error("expected exactly one decision command")
    const decision = decodeCommandPayload(h.decisionCommands[0].slice(DECISION_COMMAND_PREFIX.length)) as {
      allow: boolean
    }
    if (decision.allow !== false) throw new Error("expected the decision to carry allow:false")
  })

  await scenario("Escape / dialog close denies the request", async () => {
    const h = await createHarness()
    const pending = h.chatParams(params(), {})
    await ticks()
    expectDialog(h.getDialog()).onClose()

    await assertRejects(pending, /cancelled/)
  })

  await scenario("session approval persists: later peak requests skip the dialog", async () => {
    const h = await createHarness()

    const first = h.chatParams(params("deepseek-v4-pro", DEEPSEEK_PROVIDER_ID, "session-1", "message-1"), {})
    await ticks()
    expectDialog(h.getDialog(), [
      "Model: deepseek-v4-pro",
      "Cache-miss input: $0.66 off-peak / $1.32 peak",
      "Output:          $1.98 off-peak / $3.96 peak",
    ]).render().onConfirm()
    await first
    if (h.requestCommands.length !== 1) throw new Error("expected exactly one request command")

    const second = h.chatParams(params("deepseek-v4-flash", DEEPSEEK_PROVIDER_ID, "session-1", "message-2"), {})
    await ticks()
    await second
    await expectNoDialog(h, "approved session should not prompt again")
    if (h.requestCommands.length !== 1) throw new Error("no second request command expected")
  })
})

await withTime(OFF_PEAK_MONDAY, async () => {
  await scenario("weekday off-peak bypasses the gate silently", async () => {
    const h = await createHarness()
    await h.chatParams(params(), {})
    await expectNoDialog(h, "off-peak request must not prompt")
    if (h.requestCommands.length !== 0) throw new Error("no request command expected off-peak")
  })
})

await withTime(PEAK_CLOCK_SATURDAY, async () => {
  await scenario("weekend peak-clock hours bypass the gate silently", async () => {
    const h = await createHarness()
    await h.chatParams(params(), {})
    await expectNoDialog(h, "weekend request must not prompt")
    if (h.requestCommands.length !== 0) throw new Error("no request command expected on weekends")
  })
})

await withTime(PEAK_MONDAY, async () => {
  await scenario("non-DeepSeek providers and unsupported models bypass the gate", async () => {
    const h = await createHarness()
    await h.chatParams(params("deepseek-v4-flash", "openrouter"), {})
    await h.chatParams(params("deepseek-v4-unknown", DEEPSEEK_PROVIDER_ID), {})
    await expectNoDialog(h, "non-qualifying requests must not prompt")
    if (h.requestCommands.length !== 0) throw new Error("no request command expected for non-qualifying requests")
  })
})

if (failures > 0) {
  console.log(`\n${failures} scenario(s) failed`)
  process.exitCode = 1
} else {
  console.log("\nAll scenarios passed — full server <-> TUI round trip works")
}

async function assertRejects(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise
    throw new Error(`expected the promise to reject with ${pattern}`)
  } catch (error) {
    if ((error as Error).message.startsWith("expected the promise")) throw error
    if (!pattern.test((error as Error).message)) {
      throw new Error(`rejection message ${JSON.stringify((error as Error).message)} does not match ${pattern}`)
    }
  }
}
