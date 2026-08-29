# deepseek-pricing-gate

An OpenCode plugin that gates DeepSeek chat requests during peak pricing windows. When you send a request to a supported DeepSeek model during peak hours, the plugin pauses the request and shows a TUI confirmation dialog with the current peak vs. off-peak rates. You decide whether to proceed — the model request is only sent after explicit confirmation.

Peak rates are exactly **2x** the off-peak rates for all supported models.

## Features

- **Peak-window gating** — blocks `chat.params` for DeepSeek models during peak pricing windows (fails closed: no dialog, no request)
- **TUI confirmation dialog** — shows the model, peak windows, and per-1M-token rates (cache-hit / cache-miss input, output) for both peak and off-peak
- **One confirmation per session** — after approval, the session stays approved for the rest of the current peak window; a request crossing the end of a window is still allowed
- **60-second confirmation timeout** — stale or unanswered dialogs never leave requests hanging; the request is blocked
- **Pending request coalescing** — concurrent requests in the same session share a single confirmation
- **Safe by design** — server↔TUI payloads are base64url-encoded JSON commands validated with exact-match type guards; tampered payloads are rejected

## Supported models

| Model                          | Off-peak per 1M tokens (USD)                       | Peak per 1M tokens (USD)                           |
| ------------------------------ | -------------------------------------------------- | -------------------------------------------------- |
| `deepseek-v4-flash`            | cache-hit $0.007 / cache-miss $0.22 / output $0.66 | cache-hit $0.014 / cache-miss $0.44 / output $1.32 |
| `deepseek-v4-pro`              | cache-hit $0.022 / cache-miss $0.66 / output $1.98 | cache-hit $0.044 / cache-miss $1.32 / output $3.96 |
| `deepseek-v4-flash-vision-exp` | cache-hit $0.007 / cache-miss $0.22 / output $0.66 | cache-hit $0.014 / cache-miss $0.44 / output $1.32 |

Peak windows (UTC, half-open ranges, Mon–Fri only):

- 01:00–04:00
- 06:00–10:00

## Installation

install the published package from npm and register both the server and TUI plugins. You can install it in two scopes:

### Project scope

The plugin only applies to the current project. Install it into the project and register it in the project's config files.

```bash
npm install --save-dev deepseek-pricing-gate
```

Register the server plugin in the project's `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["deepseek-pricing-gate/server"]
}
```

Register the TUI plugin in `.opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["deepseek-pricing-gate/tui"]
}
```

### User scope (global)

The plugin applies to every project on your machine. Install it into your global opencode config and register it there.

```bash
cd ~/.config/opencode
npm install --save-dev deepseek-pricing-gate
```

Register the server plugin in `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["deepseek-pricing-gate/server"]
}
```

Register the TUI plugin in `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["deepseek-pricing-gate/tui"]
}
```

The gate only triggers during peak windows, so off-peak requests are unaffected.

## How it works

1. The server plugin observes `chat.message` events for DeepSeek models and tracks them per session.
2. On `chat.params`, if the request targets a supported DeepSeek model during a peak window and the session isn't already approved, the server publishes a confirmation request to the TUI (keyed by a nonce) and awaits a decision.
3. The TUI queues dialogs (one at a time) and publishes the decision back to the server.
4. Approved → the request proceeds; denied → the server throws, so no model request is ever sent. Unanswered (timeout, no TUI, session deleted) → fails closed and blocks the request.
5. A successful confirmation marks the session approved for the remainder of the peak window.

## Development

All development happens inside `.opencode/`:

```bash
cd .opencode
npm run typecheck   # tsc --noEmit
npm test            # bun test (node:test suite)
bun run tests/simulate-dialog.ts   # manual server↔TUI round-trip harness with a frozen clock
```

## Structure

- `deepseek-pricing-gate.shared.ts` — single source of truth: pricing table, peak windows, type guards, base64url command payload encoding (zero runtime deps)
- `plugins/deepseek-pricing-gate.server.ts` — server plugin: gates `chat.params`, manages pending confirmations, fails closed
- `tui/deepseek-pricing-gate.tui.ts` — TUI plugin: queues confirmation dialogs, publishes decisions

## License

MIT
