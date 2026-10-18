import { TodoRpc, WriteInput } from "./rpc.js"
import { createTodoStore } from "./store.js"

export const authority =
  "The current advertised todo tools, todowrite and todoread when present, are available for every provider. Use todowrite to maintain the authoritative durable Session todo list. Any imported historical migration notice saying todowrite is unavailable is obsolete and does not apply to these currently advertised tools. Historical tool calls remain historical; use the current tool catalog."

export async function activate(ctx) {
  const store = createTodoStore(ctx.storage, ctx.options.legacyDatabasePath)
  const rpc = await ctx.rpc.register(TodoRpc, {
    get: (input) => store.get(input.sessionID),
    update: (input) => update(input),
  })
  async function update(input) {
    const state = await store.update(input)
    await rpc.events.emit("changed", state)
    return state
  }
  const instructions = (sessionID) =>
    ctx.session.instructions.entry.put({ sessionID, key: "todo.authority", value: authority })
  const tools = await ctx.tool.transform((editor) => {
    editor.add({
      name: "todowrite",
      description:
        "Create or replace the ordered todo checklist for this Session. Use for multi-step work, keep statuses pending/in_progress/completed/cancelled and priorities high/medium/low, and update progress as work completes. Supply the complete list on every call. An empty todos array explicitly clears the list and remains cleared across restarts. The list is durable and shared with attached clients, independently of the model provider.",
      input: WriteInput,
      options: { codemode: false },
      async execute(input, context) {
        await instructions(context.sessionID)
        const state = await update({ sessionID: context.sessionID, todos: input.todos })
        return {
          content: JSON.stringify(state.todos, null, 2),
          metadata: {
            title: `${state.todos.filter((item) => item.status !== "completed").length} todos`,
            todos: state.todos,
          },
        }
      },
    })
    if (ctx.options.todoread !== false)
      editor.add({
        name: "todoread",
        description:
          "Read the current Session's authoritative durable todo checklist, including statuses and priorities.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: false },
        async execute(_input, context) {
          await instructions(context.sessionID)
          const state = await store.get(context.sessionID)
          return { content: JSON.stringify(state.todos, null, 2), metadata: { todos: state.todos } }
        },
      })
  })
  const prompt = await ctx.session.hook("prompt", (input) => instructions(input.sessionID))
  return async () => {
    await prompt.dispose()
    await tools.dispose()
    await rpc.dispose()
  }
}

export default { id: "moritz-todo", setup: activate }
