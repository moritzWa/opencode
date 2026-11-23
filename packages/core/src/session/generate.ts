export * as SessionGenerate from "./generate.js"

import type { FileSystem } from "../filesystem.js"
import { ai, AIError, InvalidProviderOutputError, InvalidRequestError, LLMClient, Message } from "@opencode/ai/effect"
import { Effect, Schema, type JsonSchema } from "effect"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { Instance } from "../instance/service.js"
import { Plugin } from "../plugin/service.js"
import type { Instructions } from "../instructions/index.js"
import { SessionContext } from "./context.js"
import { SessionEvent } from "./event.js"
import type { AgentNotFoundError } from "./error.js"
import { SessionHistory } from "./history.js"
import { SessionModelRequest } from "./model-request.js"
import { ModelRetry } from "../model-retry.js"
import type { SessionRunnerModel } from "./runner/model.js"
import type { SessionSchema } from "./schema.js"
import { SessionUsage } from "./usage.js"
import { ToolRuntime } from "../tool/runtime.js"

export type Error =
  | AgentNotFoundError
  | Instructions.InitializationBlocked
  | SessionRunnerModel.Error
  | AIError
  | FileSystem.DirectoryNotFoundError

export type Result = SessionUsage.Recorded & { readonly text: string }

/**
 * Generates text from current Session context without mutating history.
 * Usage is reported like a step's and added to the Session's totals.
 */
export const generate = Effect.fn("SessionGenerate.generate")(function* (input: {
  session: SessionSchema.Info
  prompt: string
  schema?: JsonSchema.JsonSchema
}) {
  const instances = yield* Instance.Service
  const database = yield* Database.Service
  const llm = yield* LLMClient.Service
  const bus = yield* Bus.Service

  return yield* Effect.gen(function* () {
    yield* Plugin.awaitActivation
    const context = yield* SessionContext.Service
    const selection = yield* context.select(input.session.id)
    const model = yield* context.resolveModel(selection.session, { kind: "generate", agent: selection.agent.id })
    const history = yield* SessionHistory.preview(database.db, selection.session.id, selection.instructions, model.ref)
    const transcript = SessionModelRequest.baseTranscript({
      agent: selection.agent.info,
      model,
      tools: selection.tools,
      initial: history.initial,
      messages: history.messages,
    })
    const prepared = yield* (input.schema === undefined ? context.request.generate : context.request.generateObject)({
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
    })
    yield* Effect.logInfo("sending session generation request", {
      sessionID: selection.session.id,
      providerID: model.ref.providerID,
      modelID: model.ref.id,
    })
    const response = yield* (
      input.schema === undefined
        ? llm.generate(prepared.request, prepared.options)
        : ai.generate({ ...prepared.request, tools: [], schema: input.schema }, prepared.options)
    ).pipe(ModelRetry.retry)
    const usage = SessionUsage.record(response.usage, model.cost)
    yield* bus.publish(SessionEvent.UsageRecorded, { sessionID: selection.session.id, source: "generate", ...usage })
    return { text: response.text, ...usage, object: "object" in response ? response.object : undefined }
  }).pipe(instances.provide(input.session))
})

/** Generates a schema-validated JSON result without executing Session tools or changing history. */
export const generateObject = Effect.fn("SessionGenerate.generateObject")(function* (input: {
  session: SessionSchema.Info
  prompt: string
  schema: JsonSchema.JsonSchema
}) {
  const codec = yield* Effect.try({
    try: () => ToolRuntime.jsonSchema(input.schema),
    catch: (cause) =>
      new AIError({
        reason: new InvalidRequestError({ message: "Unable to compile structured output schema", cause }),
      }),
  })
  const response = yield* generate(input)
  return yield* Schema.decodeUnknownEffect(codec)(response.object, { onExcessProperty: "error" }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
    Effect.mapError(
      (cause) => new AIError({ reason: new InvalidProviderOutputError({ message: cause.message, cause }) }),
    ),
  )
})
