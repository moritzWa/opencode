import { expect, test } from "bun:test"
import { modelAllowed } from "../src/context/local"
import { model, renderLocal, session } from "./fixture/local"

test("allowlist matches exact model, provider wildcard and global wildcard", () => {
  const selected = { providerID: "cursor", modelID: "gpt-6" }
  expect(modelAllowed(undefined, selected)).toBe(true)
  expect(modelAllowed(["cursor/*"], selected)).toBe(true)
  expect(modelAllowed(["cursor/gpt-6"], selected)).toBe(true)
  expect(modelAllowed(["*"], selected)).toBe(true)
  expect(modelAllowed(["openai/*", "cursor/gpt-5"], selected)).toBe(false)
})

test("a chat keeps its own saved model even when it is off the allowlist", async () => {
  await using setup = await renderLocal({
    config: { model_allowlist: ["provider/allowed"] },
    models: [model("blocked"), model("allowed")],
    sessions: [session("ses_one", { providerID: "provider", id: "blocked" })],
    preferences: { recent: [{ providerID: "provider", modelID: "allowed" }] },
  })
  await setup.data.session.sync("ses_one")
  setup.route.navigate({ type: "session", sessionID: "ses_one" })
  expect(setup.local.model.current()?.modelID).toBe("blocked")
})

test("automatic fallback/cycling excludes disallowed picks; a chat reverts to its own saved model on return", async () => {
  await using setup = await renderLocal({
    config: { model_allowlist: ["provider/allowed"] },
    models: [model("blocked"), model("allowed")],
    sessions: [session("ses_one", { providerID: "provider", id: "blocked" }), session("ses_two")],
    preferences: {
      recent: [
        { providerID: "provider", modelID: "blocked" },
        { providerID: "provider", modelID: "allowed" },
      ],
    },
  })
  expect(setup.local.model.current()?.modelID).toBe("allowed")
  await setup.data.session.sync("ses_one")
  setup.route.navigate({ type: "session", sessionID: "ses_one" })
  expect(setup.local.model.current()?.modelID).toBe("blocked")
  setup.local.model.set({ providerID: "provider", modelID: "blocked" }, { recent: true })
  expect(setup.local.model.current()?.modelID).toBe("blocked")
  setup.local.model.cycle(1)
  expect(setup.local.model.current()?.modelID).toBe("allowed")
  setup.local.model.set({ providerID: "provider", modelID: "blocked" })
  setup.route.navigate({ type: "session", sessionID: "ses_two" })
  await setup.renderOnce()
  expect(setup.local.model.current()?.modelID).toBe("allowed")
  setup.route.navigate({ type: "session", sessionID: "ses_one" })
  expect(setup.local.model.current()?.modelID).toBe("blocked")
})
