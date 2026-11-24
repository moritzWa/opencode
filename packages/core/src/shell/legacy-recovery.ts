export * as LegacyShellRecovery from "./legacy-recovery.js"

import path from "node:path"
import { Deferred, Effect, type Scope } from "effect"
import { Global } from "@opencode/util/global"
import { Job } from "../job.js"
import { ShellDurable } from "./durable.js"
import { ShellResult } from "./result.js"
import { ToolOutput } from "../tool-output.js"
import type { Session } from "../session.js"

/** Adopt commands the pre-daemon fork left running. New commands always use upstream's daemon. */
export const recover = Effect.fn("LegacyShellRecovery.recover")(function* (
  background: Job.Background,
  recovery: Extract<Job.Recovery, { kind: "shell" }>,
  notices: Pick<Session.Interface, "synthetic">,
  scope: Scope.Scope,
) {
  if (background.status !== "running") return false
  const global = yield* Global.Service
  const jobs = yield* Job.Service
  const entry = yield* Effect.promise(() => ShellDurable.find(path.join(global.data, ShellDurable.DIRECTORY), recovery.shellID))
  if (!entry) return false
  const settled = yield* Deferred.make<ShellDurable.Outcome>()
  yield* jobs.start({
    id: background.id,
    type: "shell",
    title: recovery.command,
    metadata: { sessionID: recovery.sessionID, shellID: recovery.shellID },
    recovery,
    notificationID: background.notificationID,
    cancel: ShellDurable.stop(entry),
    run: ShellDurable.wait(entry, true).pipe(
      Effect.tap((outcome) => Deferred.succeed(settled, outcome)),
      Effect.flatMap((outcome) => {
        if (outcome._tag === "exited") return Effect.succeed("exited")
        if (outcome._tag === "removed") return Effect.interrupt
        return Effect.promise(() => ShellDurable.markLost(entry.file)).pipe(
          Effect.andThen(Effect.fail(new Error("The command's process disappeared without reporting an exit status"))),
        )
      }),
    ),
  })
  yield* jobs.background(background.id)
  yield* jobs.wait({ id: background.id }).pipe(
    Effect.flatMap((result) => Effect.gen(function* () {
      const info = result.info
      if (!info || info.status === "running") return
      const outcome = info.status === "cancelled" ? undefined : yield* Deferred.await(settled)
      const tail = yield* Effect.promise(() => ShellDurable.tail(entry.file, { maxLines: ToolOutput.MAX_LINES, maxBytes: ToolOutput.MAX_BYTES }))
      const signal = outcome?._tag === "exited" ? yield* Effect.promise(() => ShellDurable.signalName(outcome.code)) : undefined
      const output = {
        output: tail?.output ?? "",
        truncated: tail?.truncated ?? false,
        exit: outcome?._tag === "exited" && signal === undefined ? outcome.code : undefined,
        signal,
      }
      const text = info.status === "cancelled" ? "Cancelled" : [
        output.output,
        ShellResult.notice(output),
        output.truncated ? `[output truncated; full output saved to ${entry.file}]` : undefined,
      ].filter(Boolean).join("\n\n")
      yield* notices.synthetic({
        ...(info.notificationID ? { id: info.notificationID } : {}),
        sessionID: recovery.sessionID,
        description: recovery.command,
        ...ShellResult.notification({
          jobID: background.id,
          shellID: recovery.shellID,
          command: recovery.command,
          state: info.status,
          text,
          ...(info.status === "completed" ? { output } : {}),
        }),
      }).pipe(Effect.catchTag("Session.NotFoundError", () => Effect.void), Effect.orDie)
      if (info.notificationID) yield* jobs.completeBackground(info.notificationID)
    })),
    Effect.forkIn(scope),
  )
  return true
})
