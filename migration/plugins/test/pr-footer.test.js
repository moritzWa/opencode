import { expect, test } from "bun:test"
import { scan } from "../legacy/tui-plugins/pr-footer.js"

const shell = (command, output = "", workdir) => ({
  type: "assistant",
  content: [{ type: "tool", name: "shell", state: { input: { command, workdir }, content: [{ type: "text", text: output }] } }],
})

const root = "/Users/m/Code/arca"

test("scan reads the PR a chat created and merged, newest first", () => {
  const events = scan([
    shell(`cd ${root}/.claude/worktrees/cleanup\ngh pr create --title x`, "https://github.com/acme/app/pull/11549\n"),
    shell(`cd ${root} && gh pr merge 11549 --squash`),
    shell("ls", "", root),
  ])
  expect(events.map((event) => event.pr?.number)).toEqual([undefined, 11549, 11549])
  expect(events[2]).toEqual({ dir: `${root}/.claude/worktrees/cleanup`, pr: { repo: "acme/app", number: 11549 } })
})

test("scan ignores pull request mentions that are not create or merge", () => {
  expect(scan([shell("gh pr view 9197", "https://github.com/acme/app/pull/9197")]).map((event) => event.pr)).toEqual([undefined])
})
