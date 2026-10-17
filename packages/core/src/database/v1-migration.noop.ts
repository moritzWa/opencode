import { Effect, Layer } from "effect"

export type Status = { readonly status: "completed" }

export const layer = Layer.empty
export function status() {
  return Effect.succeed({ status: "completed" } as const)
}
export type Options = { readonly nextDatabasePath?: string | false; readonly refresh?: boolean }
export function run(_options: Options = {}) {
  return Effect.succeed({ status: "completed" } as const)
}
export function stageSource(_options: {
  readonly sourceDatabasePath: string
}): Effect.Effect<{ sessions: number; messages: number; parts: number }> {
  return Effect.die(new Error("V1 source staging requires the Bun SQLite runtime"))
}
