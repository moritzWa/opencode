import { expect, test } from "bun:test"
import { makeClient } from "../bridge.js"
import { host } from "./host.js"

const agentModels = {
  "opencode-memory-extract": { providerID: "anthropic", id: "claude-sonnet-5-5" },
}

test("a prompt naming an agent runs on that agent's configured model", async () => {
  const fixture = host("/tmp/fixture", { agentModels })
  await makeClient(fixture.context).session.prompt({
    path: { id: "ses_fixture" },
    body: { agent: "opencode-memory-extract", parts: [{ type: "text", text: "conversation" }] },
  })
  expect(fixture.sessions.get("ses_fixture")).toMatchObject({
    agent: "opencode-memory-extract",
    model: { providerID: "anthropic", id: "claude-sonnet-5-5" },
  })
})

test("an explicit model wins over the agent's model, and agents without one keep the session model", async () => {
  const fixture = host("/tmp/fixture", { agentModels })
  const client = makeClient(fixture.context)
  await client.session.prompt({
    path: { id: "ses_fixture" },
    body: { agent: "opencode-memory-extract", model: { providerID: "openai", modelID: "gpt-6-luna" }, parts: [] },
  })
  expect(fixture.sessions.get("ses_fixture").model).toEqual({ providerID: "openai", id: "gpt-6-luna" })
  fixture.sessions.get("ses_fixture").model = undefined
  await client.session.prompt({ path: { id: "ses_fixture" }, body: { agent: "build", parts: [] } })
  expect(fixture.sessions.get("ses_fixture").model).toBeUndefined()
})
