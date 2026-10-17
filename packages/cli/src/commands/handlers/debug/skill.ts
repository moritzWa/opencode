import { EOL } from "os"
import { Effect } from "effect"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/effect/service"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServerConnection } from "../../../services/server-connection"

export default Runtime.handler(
  Commands.commands.debug.commands.skill,
  Effect.fn("cli.debug.skill")(function* (input) {
    const { endpoint } = yield* ServerConnection.resolve()
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    const location = { directory: process.cwd() }
    const response = input.diagnostics
      ? yield* Effect.promise(() => client.skill.diagnostics({ location }))
      : yield* Effect.promise(() => client.skill.list({ location }))
    process.stdout.write(JSON.stringify(response.data, null, 2) + EOL)
  }),
)
