import { Skill } from "@opencode/core/skill"
import { HttpApiBuilder } from "effect/http-api"
import { Effect } from "effect"
import { Api } from "../api"
import { response } from "../location"

export const SkillHandler = HttpApiBuilder.group(Api, "server.skill", (handlers) =>
  handlers
    .handle("skill.list", () => response(Skill.Service.use((skill) => skill.list())))
    .handle("skill.diagnostics", () =>
      Effect.gen(function* () {
        const skill = yield* Skill.Service
        return yield* response(skill.diagnostics())
      }),
    ),
)
