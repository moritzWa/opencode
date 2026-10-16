import { EOL } from "os"
import { Effect } from "effect"
import { Skill } from "../../../skill"
import { effectCmd } from "../../effect-cmd"

export const SkillCommand = effectCmd({
  command: "skill",
  describe: "list all available skills",
  builder: (yargs) =>
    yargs.option("diagnostics", {
      type: "boolean",
      default: false,
      describe: "show discovered files, load status and skip reasons (fresh process scan)",
    }),
  handler: Effect.fn("Cli.debug.skill")(function* (args) {
    const skill = yield* Skill.Service
    const skills = args.diagnostics ? yield* skill.diagnostics() : yield* skill.all()
    process.stdout.write(JSON.stringify(skills, null, 2) + EOL)
  }),
})
