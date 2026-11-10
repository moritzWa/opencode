import { describe, expect, test } from "bun:test"
import { fallback } from "../src/policy.ts"
import { COMPACT_ABOVE, contextTokens, decideReturn, repicked, type ReturnInput, type ReturnMessage } from "../src/return.ts"

const sonnet = { providerID: "anthropic", id: "claude-sonnet-5-5" }
const sol = { providerID: "openai", id: "gpt-6.1-sol" }
const grok = { providerID: "xai", id: "grok-4.7" }
const quota = { category: "model_quota" as const, reason: "quota_exceeded" }

const assistant = (input: number, created = 10): ReturnMessage => ({ type: "assistant", time: { created }, tokens: { input, output: 100, cache: { read: 0, write: 0 } } })
const switched = (created: number): ReturnMessage => ({ type: "model-switched", time: { created }, model: grok })
const base: ReturnInput = { model: grok, messages: [assistant(120_000)], held: [], cooling: [], available: [sonnet, sol, grok], active: false }

describe("last-resort model", () => {
  test("is the final rung once both subscriptions are out", () => {
    expect(fallback({ failure: quota, failed: sonnet, available: [sonnet, sol, grok] })).toEqual(sol)
    expect(fallback({ failure: quota, failed: sonnet, available: [sonnet, sol, grok], held: ["openai"] })).toEqual(grok)
    expect(fallback({ failure: quota, failed: sol, available: [sonnet, sol, grok], held: ["anthropic"] })).toEqual(grok)
  })

  test("is never offered when it is not available, and never falls further", () => {
    expect(fallback({ failure: quota, failed: sonnet, available: [sonnet, sol], held: ["openai"] })).toBeUndefined()
    expect(fallback({ failure: quota, failed: grok, available: [sonnet, sol, grok] })).toBeUndefined()
  })
})

describe("return to Sonnet", () => {
  test("a Grok session moves home without compaction while it is small", () => {
    expect(decideReturn(base)).toEqual({ move: true, compact: false, tokens: 120_100 })
  })

  test("compacts only above the threshold", () => {
    expect(decideReturn({ ...base, messages: [assistant(COMPACT_ABOVE - 200)] })).toMatchObject({ move: true, compact: false })
    expect(decideReturn({ ...base, messages: [assistant(COMPACT_ABOVE)] })).toMatchObject({ move: true, compact: true })
    expect(decideReturn({ ...base, messages: [assistant(350_000)] })).toMatchObject({ move: true, compact: true, tokens: 350_100 })
  })

  test("measures the newest answered request, ignoring failed ones", () => {
    const failed: ReturnMessage = { ...assistant(900_000, 30), error: { type: "provider.error" } }
    expect(contextTokens([assistant(200_000, 10), failed])).toBe(200_100)
    expect(contextTokens([])).toBe(0)
  })

  test("other models are left alone", () => {
    expect(decideReturn({ ...base, model: sonnet })).toMatchObject({ move: false })
    expect(decideReturn({ ...base, model: sol })).toMatchObject({ move: false })
    expect(decideReturn({ ...base, model: undefined })).toMatchObject({ move: false })
  })

  test("waits while Claude is held, cooling, or unavailable", () => {
    expect(decideReturn({ ...base, held: ["anthropic"] })).toMatchObject({ move: false, reason: "Claude is held" })
    expect(decideReturn({ ...base, held: ["openai"] })).toMatchObject({ move: true })
    expect(decideReturn({ ...base, cooling: ["anthropic/*"] })).toMatchObject({ move: false })
    expect(decideReturn({ ...base, cooling: ["anthropic/claude-sonnet-5-5"] })).toMatchObject({ move: false })
    expect(decideReturn({ ...base, cooling: ["anthropic/claude-opus-5-5"] })).toMatchObject({ move: true })
    expect(decideReturn({ ...base, available: [sol, grok] })).toMatchObject({ move: false })
  })

  test("never switches a running session", () => {
    expect(decideReturn({ ...base, active: true })).toMatchObject({ move: false, reason: "session is running" })
  })
})

describe("picking Grok again after a return", () => {
  const returned = { modelReturn: { at: 100 } }

  test("a bare switch after the return sticks", () => {
    expect(repicked([switched(200)], 100)).toBe(true)
    expect(decideReturn({ ...base, messages: [switched(200), assistant(10_000, 210)], metadata: returned })).toMatchObject({ move: false, reason: "picked again after a return" })
  })

  test("a fallback switch, which comes with its recovery marker, does not stick", () => {
    const marker: ReturnMessage = { type: "synthetic", time: { created: 201 }, metadata: { recovery: { userMessageID: "msg_1" } } }
    expect(repicked([switched(200), marker], 100)).toBe(false)
    expect(decideReturn({ ...base, messages: [switched(200), marker], metadata: returned })).toMatchObject({ move: true })
  })

  test("a switch from before the return, or no earlier return, does not stick", () => {
    expect(repicked([switched(50)], 100)).toBe(false)
    expect(repicked([switched(200)], undefined)).toBe(false)
    expect(decideReturn({ ...base, messages: [switched(200)] })).toMatchObject({ move: true })
  })
})
