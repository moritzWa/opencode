import { expect, test } from "bun:test"
import { Schema } from "effect"
import { TuiConfigV1 } from "@opencode/tui/config/v1"
import { migrateV1 } from "../src/config/migrate"

test("V1 daily keybindings, paste behavior, model policy and hidden hints survive CLI migration", () => {
  const legacy = Schema.decodeUnknownSync(TuiConfigV1.Info)({
    theme: "claude-code",
    model_allowlist: ["anthropic/*", "cursor/*", "openai/*"],
    keybinds: {
      leader: "ctrl+y",
      messages_first: "home",
      messages_last: "ctrl+g,ctrl+l,ctrl+alt+g,end",
      command_list: "ctrl+p,ctrl+t",
      variant_cycle: "none",
      sidebar_toggle: "<leader>b,ctrl+q",
      session_search: "<leader>f",
      input_paste: { key: "ctrl+v,super+v", preventDefault: false },
    },
  })
  const migrated = migrateV1(legacy, { footer_hints_enabled: false })
  expect(migrated.theme?.name).toBe("claude-code")
  expect(migrated.model_allowlist).toEqual(["anthropic/*", "cursor/*", "openai/*"])
  expect(migrated.prompt?.hints).toBe(false)
  expect(migrated.keybinds).toMatchObject({
    leader: "ctrl+y",
    "session.first": "home",
    "session.last": "ctrl+g,ctrl+l,ctrl+alt+g,end",
    "command.palette.show": "ctrl+p,ctrl+t",
    "variant.cycle": "none",
    "session.sidebar.toggle": "<leader>b,ctrl+q",
    "session.search": "<leader>f",
    "prompt.paste": { key: "ctrl+v,super+v", preventDefault: false },
  })
})
