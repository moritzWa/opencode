import { Skill } from "@opencode/core/skill"
import { HttpApiBuilder } from "effect/http-api"
import { Effect } from "effect"
import { Api } from "../api"
import { awaitPlugins, response } from "../location"

export const SkillHandler = HttpApiBuilder.group(Api, "server.skill", (handlers) =>
  handlers
    .handle("skill.list", () => response(Skill.Service.use((skill) => skill.list())))
    .handle("skill.diagnostics", () =>
      Effect.gen(function* () {
        yield* awaitPlugins
        const skill = yield* Skill.Service
        return yield* response(skill.diagnostics())
      }),
    ),
)
