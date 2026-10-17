import { Auth, LLMClient, RequestExecutor } from "@opencode/ai/route"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import type { LanguageModel } from "@opencode/ai"
import { Model } from "@opencode/core/model"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Agent } from "@opencode/core/agent"
import { Config } from "@opencode/core/config"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { Snapshot } from "@opencode/core/snapshot"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionRunCoordinator } from "@opencode/core/session/run-coordinator"
import { SessionRunner } from "@opencode/core/session/runner/index"
import { SessionRunnerLLM } from "@opencode/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Tool } from "@opencode/core/tool"
import { SessionStore } from "@opencode/core/session/store"
import { Location } from "@opencode/core/location"
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { Instructions } from "@opencode/core/instructions/index"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { ReferenceInstructions } from "@opencode/core/reference/instructions"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Permission } from "@opencode/core/permission"
import { FileAccess } from "@opencode/core/file-access"
import { FileMutation } from "@opencode/core/file-mutation"
import { Formatter } from "@opencode/core/formatter"
import { Environment } from "@opencode/core/environment/index"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { promptLocationNode } from "./prompt-location"
import { permissionLayer } from "../lib/permission"

/** Real HTTP executor and durable runner, with only discovery/model inventory
 * supplied by the fixture. Tools are production registrations, never copies. */
export function recoveryRunnerLayer(directory: string, baseURL: string, primary?: LanguageModel, database = ":memory:") {
  const client = LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer), Layer.provide(FetchHttpClient.layer))
  const models = Layer.mock(SessionRunnerModel.Service)({
    resolve: (session) => Effect.succeed(SessionRunnerModel.resolved(
      !session.model && primary ? primary : OpenAIChat.route.with({ endpoint: { baseURL }, auth: Auth.bearer("fixture") }).model({ id: session.model?.id ?? "claude-subscription" }),
      { capabilities: { tools: true, input: ["text"], output: ["text"] }, cost: [], limit: { context: 200000, output: 1000 } },
    )),
  })
  const builtins = Layer.mock(InstructionBuiltIns.Service, { load: () => Effect.succeed(Instructions.empty) })
  const discovery = Layer.mock(InstructionDiscovery.Service, { project: true, global: true, load: () => Effect.succeed(Instructions.empty) })
  const skills = Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
  const references = Layer.mock(ReferenceInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
  const mcp = Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
  const inventory = Layer.mock(Model.Service, { get: () => Effect.undefined, all: () => Effect.succeed([]), available: () => Effect.succeed([]), default: () => Effect.undefined, small: () => Effect.undefined })
  const permission = permissionLayer({ assert: () => Effect.void })
  const replacements: LayerNode.Replacements = [
    Database.node.replace(Database.configured({ path: database })),
    Snapshot.node.replace(Snapshot.noopLayer),
    LayerNodePlatform.llmClient.replace(client),
    SessionRunnerModel.node.replace(models),
    InstructionBuiltIns.node.replace(builtins),
    InstructionDiscovery.node.replace(discovery),
    Location.node.replace(Location.boundNode({ directory: AbsolutePath.make(directory) })),
    SkillInstructions.node.replace(skills),
    ReferenceInstructions.node.replace(references),
    McpInstructions.node.replace(mcp),
    Config.node.replace(Config.testLayer()),
    Permission.node.replace(permission),
    PluginSupervisor.node.replace(Layer.empty),
    Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
  ]
  const runner = AppNodeBuilder.build(SessionRunnerLLM.node, replacements)
  const execution = Layer.effect(SessionExecution.Service, Effect.gen(function* () {
    const sessions = yield* SessionRunner.Service
    const coordinator = yield* SessionRunCoordinator.make<Session.ID, SessionRunner.RunError>({ drain: (sessionID, force) => sessions.drain({ sessionID, force }).pipe(Effect.asVoid) })
    return SessionExecution.Service.of({ active: coordinator.active, isActive: coordinator.isActive, resume: coordinator.run, wake: coordinator.wake, interrupt: (sessionID) => coordinator.interrupt(sessionID), awaitIdle: coordinator.awaitIdle })
  })).pipe(Layer.provide(runner), Layer.orDie)
  return AppNodeBuilder.build(LayerNode.group([
    Database.node, Bus.node, SessionProjector.node, SessionStore.node,
    Agent.node, Model.node, PluginHooks.node, Tool.node, SessionRunnerLLM.node,
    Session.node, FileAccess.node, FileMutation.node, Formatter.node, Environment.node, Permission.node,
  ]), [
    ...replacements,
    Bus.node.replace(Bus.configured({ persist: true })),
    LocationServiceMap.node.replace(promptLocationNode),
    Model.node.replace(inventory),
    SessionExecution.node.replace(execution),
  ])
}
