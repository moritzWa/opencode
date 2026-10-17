import { expect, test } from "bun:test"
import { OpenCode } from "../src/promise/index"

test("skill.diagnostics forwards location and preserves the diagnostic response", async () => {
  const report = {
    location: { directory: "/project" },
    data: [{ path: "/skills/manual/SKILL.md", id: "manual", status: "unadvertised", reason: "No description" }],
  }
  const client = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      expect(request.method).toBe("GET")
      expect(url.pathname).toBe("/api/skill/diagnostics")
      expect(url.searchParams.get("location[directory]")).toBe("/project")
      return Response.json(report)
    },
  })
  expect(await client.skill.diagnostics({ location: { directory: "/project" } })).toEqual(report)
})
