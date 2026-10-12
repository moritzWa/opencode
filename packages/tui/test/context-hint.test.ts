import { describe, expect, test } from "bun:test"
import { contextHint } from "../src/component/prompt/context-hint"

const tokens = (input: number, read = 0, total?: number) => ({
  input,
  output: 1000,
  reasoning: 0,
  cache: { read, write: 0 },
  total,
})

describe("compaction reminder", () => {
  test("includes cached input and warns at 100k on large models", () => {
    const limit = { context: 400_000, input: 272_000 }
    expect(contextHint(tokens(1000, 97_000), limit)?.warn).toBe(false)
    expect(contextHint(tokens(1000, 98_000), limit)).toEqual({
      used: 100_000,
      threshold: 100_000,
      warn: true,
      label: "ctx 100k",
    })
  })
  test("uses half the input budget for smaller models", () => {
    expect(contextHint(tokens(31_000), { context: 128_000, input: 64_000 })?.warn).toBe(true)
  })
  test("prefers authoritative total and clears after a smaller prompt", () => {
    expect(contextHint(tokens(200_000, 0, 20_000), { context: 272_000 })?.warn).toBe(false)
    expect(contextHint(tokens(0, 0, 0), { context: 272_000 })?.used).toBe(1000)
  })
  test("does not display unmeasured usage", () => {
    expect(
      contextHint({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, { context: 0 }),
    ).toBeUndefined()
  })
})
