import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Skill } from "../src/skill.js"

test("skill diagnostics expose a closed status set and omit undefined optional fields", () => {
  const encode = Schema.encodeSync(Skill.Diagnostic)
  expect(encode({ path: "/skills/broken/SKILL.md", status: "skipped", id: undefined, reason: undefined })).toEqual({
    path: "/skills/broken/SKILL.md",
    status: "skipped",
  })
  expect(Schema.is(Skill.Diagnostic)({ path: "/skills/test/SKILL.md", status: "unknown" })).toBe(false)
})
