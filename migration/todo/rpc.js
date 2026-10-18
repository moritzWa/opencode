import { Rpc } from "@opencode/plugin/rpc"

export const Todos = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      content: { type: "string", description: "Brief task description" },
      status: { type: "string", description: "pending, in_progress, completed, or cancelled" },
      priority: { type: "string", description: "high, medium, or low" },
    },
    required: ["content", "status", "priority"],
  },
}
export const SessionInput = {
  type: "object",
  additionalProperties: false,
  properties: { sessionID: { type: "string", minLength: 1 } },
  required: ["sessionID"],
}
export const WriteInput = {
  type: "object",
  additionalProperties: false,
  properties: { todos: Todos },
  required: ["todos"],
}
export const State = {
  type: "object",
  additionalProperties: false,
  properties: { sessionID: { type: "string" }, todos: Todos, revision: { type: "integer", minimum: 0 } },
  required: ["sessionID", "todos", "revision"],
}
export const TodoRpc = Rpc.define({
  id: "moritz-todo",
  methods: {
    get: { input: SessionInput, output: State },
    update: {
      input: {
        ...SessionInput,
        properties: { ...SessionInput.properties, todos: Todos },
        required: ["sessionID", "todos"],
      },
      output: State,
    },
  },
  events: { changed: { schema: State } },
})

export function parseTodos(value) {
  if (!Array.isArray(value)) throw new Error("Expected a todo array")
  return value.map((item) => {
    if (
      !item ||
      typeof item.content !== "string" ||
      typeof item.status !== "string" ||
      typeof item.priority !== "string"
    )
      throw new Error("Each todo requires string content, status, and priority")
    return { content: item.content, status: item.status, priority: item.priority }
  })
}
