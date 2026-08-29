export const PLUGIN_ID = "deepseek-pricing-gate"
export const REQUEST_COMMAND_PREFIX = `${PLUGIN_ID}:request:`
export const DECISION_COMMAND_PREFIX = `${PLUGIN_ID}:decision:`
export const CONFIRMATION_TIMEOUT_MS = 60_000
export const DEEPSEEK_PROVIDER_ID = "deepseek"

export const PEAK_WINDOWS = [
  "Monday-Friday 01:00-04:00 UTC",
  "Monday-Friday 06:00-10:00 UTC",
] as const

export const SUPPORTED_MODEL_IDS = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash-vision-exp",
] as const

export type SupportedModelID = (typeof SUPPORTED_MODEL_IDS)[number]

export type RateTable = {
  cacheHit: number
  cacheMiss: number
  output: number
}

type PricingRow = {
  offPeak: RateTable
  peak: RateTable
}

export const PRICING: Record<SupportedModelID, PricingRow> = {
  "deepseek-v4-flash": {
    offPeak: { cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 },
    peak: { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 },
  },
  "deepseek-v4-pro": {
    offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
    peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
  },
  "deepseek-v4-flash-vision-exp": {
    offPeak: { cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 },
    peak: { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 },
  },
}

export type PricingDetails = {
  modelID: SupportedModelID
  offPeak: RateTable
  peak: RateTable
  multiplier: 2
  peakWindows: readonly string[]
}

export type ConfirmationRequest = {
  nonce: string
  sessionID: string
  modelID: SupportedModelID
  pricing: PricingDetails
}

export type ConfirmationDecision = {
  nonce: string
  sessionID: string
  modelID: string
  allow: boolean
}

export function isSupportedModel(modelID: string): modelID is SupportedModelID {
  return Object.prototype.hasOwnProperty.call(PRICING, modelID)
}

export function pricingForModel(modelID: string): PricingDetails | undefined {
  if (!isSupportedModel(modelID)) return undefined

  const row = PRICING[modelID]
  return {
    modelID,
    offPeak: { ...row.offPeak },
    peak: { ...row.peak },
    multiplier: 2,
    peakWindows: [...PEAK_WINDOWS],
  }
}

export function isPeakUtc(date: Date): boolean {
  const timestamp = date.getTime()
  if (Number.isNaN(timestamp)) return false

  const day = date.getUTCDay()
  if (day < 1 || day > 5) return false

  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes()
  return (minutes >= 60 && minutes < 240) || (minutes >= 360 && minutes < 600)
}

export function isPricingDetails(value: unknown, modelID: string): value is PricingDetails {
  const expected = pricingForModel(modelID)
  if (!expected || !isRecord(value)) return false

  return (
    value.modelID === expected.modelID &&
    value.multiplier === expected.multiplier &&
    isRateTable(value.offPeak) &&
    isRateTable(value.peak) &&
    sameRateTable(value.offPeak, expected.offPeak) &&
    sameRateTable(value.peak, expected.peak) &&
    Array.isArray(value.peakWindows) &&
    value.peakWindows.length === expected.peakWindows.length &&
    value.peakWindows.every((window, index) => window === expected.peakWindows[index])
  )
}

export function isConfirmationRequest(value: unknown): value is ConfirmationRequest {
  if (!isRecord(value)) return false

  return (
    isNonEmptyString(value.nonce) &&
    isNonEmptyString(value.sessionID) &&
    isSupportedModel(value.modelID as string) &&
    isPricingDetails(value.pricing, value.modelID as string)
  )
}

export function isConfirmationDecision(value: unknown): value is ConfirmationDecision {
  if (!isRecord(value)) return false

  return (
    isNonEmptyString(value.nonce) &&
    isNonEmptyString(value.sessionID) &&
    isNonEmptyString(value.modelID) &&
    typeof value.allow === "boolean"
  )
}

export function encodeCommandPayload(payload: object): string {
  const json = JSON.stringify(payload)
  const bytes = new TextEncoder().encode(json)
  let binary = ""

  for (const byte of bytes) binary += String.fromCharCode(byte)

  return globalThis
    .btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
}

export function decodeCommandPayload(encoded: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("Invalid command payload encoding")

  const padded = encoded.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (encoded.length % 4)) % 4)
  const binary = globalThis.atob(padded)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
}

function isRateTable(value: unknown): value is RateTable {
  return (
    isRecord(value) &&
    typeof value.cacheHit === "number" &&
    Number.isFinite(value.cacheHit) &&
    typeof value.cacheMiss === "number" &&
    Number.isFinite(value.cacheMiss) &&
    typeof value.output === "number" &&
    Number.isFinite(value.output)
  )
}

function sameRateTable(left: RateTable, right: RateTable): boolean {
  return left.cacheHit === right.cacheHit && left.cacheMiss === right.cacheMiss && left.output === right.output
}
