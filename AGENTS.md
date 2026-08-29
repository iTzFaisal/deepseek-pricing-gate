# AGENTS.md

This repo contains the `deepseek-pricing-gate` OpenCode plugin set. Everything lives under `.opencode/` — there is no root `package.json`; all dev commands run from `.opencode/`.

## Commands (run in `.opencode/`)

- `npm run typecheck` — `tsc --noEmit`
- `npm test` — runs `bun test` (requires `bun` on PATH; runs `node:test` files)
- `bun run tests/simulate-dialog.ts` — manual end-to-end harness simulating the full server↔TUI round trip with a frozen clock. Not picked up by `bun test` (name doesn't match the test pattern); run it explicitly to validate the wiring.

## Structure

- `deepseek-pricing-gate.shared.ts` — single source of truth: pricing table, peak windows, type guards, URL-safe base64 command payload encoding. Zero runtime deps. Shared types/pricing belong here, not duplicated elsewhere.
- `plugins/deepseek-pricing-gate.server.ts` — server plugin. Gates `chat.params` for provider `deepseek` + supported models during peak windows. Fails closed (throws → no model request sent). One confirmation per session (`approvedSessions`), 60s timeout, pending confirmations keyed by nonce.
- `tui/deepseek-pricing-gate.tui.ts` — TUI plugin: queues confirmation dialogs, publishes decisions. Registered in `tui.json`.
- `tests/deepseek-pricing-gate.test.ts` — `node:test` suite (8 tests) run by bun.

## Conventions / gotchas

- ESM + NodeNext: relative imports MUST use the `.js` extension in specifiers (source is `.ts`, import path is `.js`).
- Peak windows are half-open UTC ranges: Mon–Fri 01:00–04:00 and 06:00–10:00. Tests freeze `globalThis.Date` (see `withFixedNow` in the test file); new time-dependent tests must do the same.
- Server↔TUI payloads are base64url-encoded JSON commands (`encodeCommandPayload`/`decodeCommandPayload`). Validation in shared.ts is exact-match — e.g. `isConfirmationRequest` rejects payloads with altered pricing. Don't bypass encoding or relax guards.
- Server test stubs for `client.tui.publish` must resolve `{ data: true, error: undefined }` for the success path.
