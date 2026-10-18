import { createEffect, createMemo, createSignal, For, Show, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { TodoRpc } from "../rpc.js"

export function TodoSidebar(props) {
  const [open, setOpen] = createSignal(true)
  const visible = createMemo(() => props.todos.length > 0 && props.todos.some((item) => item.status !== "completed"))
  return (
    <Show when={visible()}>
      <box flexShrink={0}>
        <box flexDirection="row" gap={1} onMouseDown={() => props.todos.length > 2 && setOpen((value) => !value)}>
          <Show when={props.todos.length > 2}>
            <text fg={props.theme.text.base}>{open() ? "▼" : "▶"}</text>
          </Show>
          <text fg={props.theme.text.base}>
            <b>Todo</b>
          </text>
        </box>
        <Show when={props.todos.length <= 2 || open()}>
          <For each={props.todos}>
            {(item) => (
              <box flexDirection="row">
                <text
                  flexShrink={0}
                  fg={item.status === "in_progress" ? props.theme.text.feedback.warning.base : props.theme.text.muted}
                >
                  [{item.status === "completed" ? "✓" : item.status === "in_progress" ? "•" : " "}]{" "}
                </text>
                <text
                  flexGrow={1}
                  wrapMode="word"
                  fg={item.status === "in_progress" ? props.theme.text.feedback.warning.base : props.theme.text.muted}
                >
                  {item.content}
                </text>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}

export default {
  id: "moritz-todo",
  setup(context) {
    const rpc = context.client.rpc(TodoRpc)
    const [states, setStates] = createStore({})
    const active = new Map()
    const controller = new AbortController()
    const accept = (state) => {
      if (controller.signal.aborted) return
      if (state.revision < (states[state.sessionID]?.revision ?? -1)) return
      setStates(state.sessionID, state)
    }
    const refresh = (sessionID) => {
      const location = context.data.session.get(sessionID)?.location ?? context.location
      return rpc
        .get({ sessionID }, { location, signal: controller.signal })
        .then(accept)
        .catch((error) => {
          if (!controller.signal.aborted)
            context.ui.toast.show({ variant: "error", message: `Could not load todos: ${error.message}` })
        })
    }
    // Use the host's reconnecting event channel, not a second live-only SSE
    // iterator that would silently end when the connection drops.
    const events = context.data.listen(({ details }) => {
      if (details.type === "rpc.moritz-todo.changed") accept(details.data)
    })
    const connected = context.data.on("server.connected", () => {
      active.forEach((_, sessionID) => {
        void refresh(sessionID)
      })
    })
    const slot = context.ui.slot({
      append: "sidebar.content",
      render(props) {
        createEffect(() => {
          const sessionID = props.sessionID
          active.set(sessionID, (active.get(sessionID) ?? 0) + 1)
          void refresh(sessionID)
          onCleanup(() => {
            const count = active.get(sessionID) - 1
            if (count) active.set(sessionID, count)
            if (!count) active.delete(sessionID)
          })
        })
        return <TodoSidebar todos={states[props.sessionID]?.todos ?? []} theme={context.theme} />
      },
    })
    return () => {
      controller.abort()
      events()
      connected()
      slot()
    }
  },
}
