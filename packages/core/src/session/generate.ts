export * as SessionGenerate from "./generate.js"

import type { FileSystem } from "../filesystem.js"
import { AIError, InvalidProviderOutputError, InvalidRequestError, LLM, LLMClient, Message } from "@opencode/ai"
import { Effect, Schema, type JsonSchema } from "effect"
import { Database } from "../database/database.js"
import { Instance } from "../instance/service.js"
import { Plugin } from "../plugin/service.js"
import type { Instructions } from "../instructions/index.js"
import { SessionContext } from "./context.js"
import type { AgentNotFoundError } from "./error.js"
import { SessionHistory } from "./history.js"
import { SessionProviderContext } from "./provider-context.js"
import { SessionModelRequest } from "./model-request.js"
import { ModelRetry } from "../model-retry.js"
import type { SessionRunnerModel } from "./runner/model.js"
import type { SessionSchema } from "./schema.js"
import { ToolRuntime } from "../tool/runtime.js"

export type Error =
  | AgentNotFoundError
  | Instructions.InitializationBlocked
  | SessionRunnerModel.Error
  | AIError
  | FileSystem.DirectoryNotFoundError

interface Input {
  session: SessionSchema.Info
  prompt: string
}

/** Generates text from current Session context without mutating the Session. */
export const generate = Effect.fn("SessionGenerate.generate")(function* (input: Input) {
  const instances = yield* Instance.Service
  const llm = yield* LLMClient.Service

  return yield* Effect.gen(function* () {
    const prepared = yield* prepare(input)
    const response = yield* llm.generate(prepared.request, prepared.options).pipe(ModelRetry.retry)
    yield* Effect.logInfo("session generation usage diagnostic", { usage: response.usage })
    return response.text
  }).pipe(instances.provide(input.session))
})

/** The only advertised tool is the synthetic output carrier; no Session tool executes. */
export const generateObject = Effect.fn("SessionGenerate.generateObject")(function* (
  input: Input & {
    schema: JsonSchema.JsonSchema
  },
) {
  const instances = yield* Instance.Service
  const codec = yield* Effect.try({
    try: () => ToolRuntime.jsonSchema(input.schema),
    catch: (cause) =>
      new AIError({
        reason: new InvalidRequestError({
          message: `Unable to compile structured output schema: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        }),
      }),
  })
  return yield* Effect.gen(function* () {
    const prepared = yield* prepare(input, true)
    const response = yield* LLM.generateObject(
      { ...prepared.request, jsonSchema: input.schema },
      prepared.options,
    ).pipe(ModelRetry.retry)
    yield* Effect.logInfo("session generation usage diagnostic", { usage: response.usage })
    return yield* Schema.decodeUnknownEffect(codec)(response.object, { errors: "all", onExcessProperty: "error" }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
      Effect.mapError(
        (cause) =>
          new AIError({
            reason: new InvalidProviderOutputError({
              message: `Structured output did not match the requested schema: ${cause.message}`,
              cause,
            }),
          }),
      ),
    )
  }).pipe(instances.provide(input.session))
})

const prepare = Effect.fn("SessionGenerate.prepare")(function* (input: Input, structured = false) {
  const database = yield* Database.Service
  yield* Plugin.awaitActivation
  const context = yield* SessionContext.Service
  const selection = yield* context.select(input.session.id)
  const model = yield* context.resolveModel(selection.session)
  const history = yield* SessionHistory.preview(
    database.db,
    selection.session.id,
    selection.instructions,
    SessionProviderContext.provenance(model) ?? "local",
  )
  const transcript = SessionModelRequest.baseTranscript({
    agent: selection.agent.info,
    model,
    tools: selection.tools,
    initial: history.initial,
    messages: history.messages,
  })
  const request = {
    session: selection.session,
    agent: selection.agent.id,
    model,
    tools: selection.tools,
    system: transcript.system,
    messages: [
      ...transcript.messages,
      ...(history.instructionUpdate ? [Message.system(history.instructionUpdate)] : []),
      Message.user(input.prompt),
    ],
  }
  const prepared = yield* structured ? context.request.generateObject(request) : context.request.generate(request)
  yield* Effect.logInfo("sending session generation request", {
    sessionID: selection.session.id,
    providerID: model.ref.providerID,
    modelID: model.ref.id,
  })
  return prepared
})
