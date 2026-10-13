import { expect, test } from "bun:test"
import { modelAllowed, parseModel, recentModels } from "../../src/context/local"

test("parses model IDs containing slashes", () => {
  expect(parseModel("provider/family/model")).toEqual({
    providerID: "provider",
    modelID: "family/model",
  })
})

test("moves a model to the front, deduplicates, and limits recents", () => {
  const recent = Array.from({ length: 12 }, (_, index) => ({
    providerID: "provider",
    modelID: `model-${index}`,
  }))

  expect(recentModels({ providerID: "provider", modelID: "model-5" }, recent)).toEqual([
    { providerID: "provider", modelID: "model-5" },
    ...recent.slice(0, 5),
    ...recent.slice(6, 10),
  ])
})

test("model allowlist matches exact models, provider wildcards and everything", () => {
  const abliterated = { providerID: "abliteration-ai", modelID: "abliterated-model" }
  const sonnet = { providerID: "anthropic", modelID: "claude-sonnet-5-5" }
  expect(modelAllowed(undefined, abliterated)).toBe(true)
  expect(modelAllowed([], abliterated)).toBe(true)
  expect(modelAllowed(["anthropic/*", "openai/gpt-6.1-sol"], abliterated)).toBe(false)
  expect(modelAllowed(["anthropic/*", "openai/gpt-6.1-sol"], sonnet)).toBe(true)
  expect(modelAllowed(["openai/gpt-6.1-sol"], { providerID: "openai", modelID: "gpt-6.1-sol" })).toBe(true)
  expect(modelAllowed(["openai/gpt-6.1"], { providerID: "openai", modelID: "gpt-6.1-sol" })).toBe(false)
  expect(modelAllowed(["anthropic"], sonnet)).toBe(false)
  expect(modelAllowed(["*"], abliterated)).toBe(true)
})
