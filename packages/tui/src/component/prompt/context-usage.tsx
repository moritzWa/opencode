import { createMemo, Show } from "solid-js"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { contextHint } from "./context-hint"

export function ContextUsage(props: { sessionID?: string }) {
  const sync = useSync()
  const { theme } = useTheme()
  const usage = createMemo(() => {
    if (!props.sessionID) return
    const last = (sync.data.message[props.sessionID] ?? []).findLast(
      (message) =>
        message.role === "assistant" &&
        (message.summary ||
          (message.time.completed &&
            (message.tokens.total ||
              message.tokens.input + message.tokens.output + message.tokens.cache.read + message.tokens.cache.write) >
              0)),
    )
    // A compaction summary's usage describes the old history, not the compacted
    // prompt. Wait for the next measured turn rather than showing a stale alert.
    if (!last || last.role !== "assistant" || last.summary) return
    const model = sync.data.provider.find((provider) => provider.id === last.providerID)?.models[last.modelID]
    return contextHint(last.tokens, model?.limit ?? { context: 0 })
  })
  return (
    <Show when={usage()}>
      {(item) => (
        <box flexShrink={1} minWidth={0} overflow="hidden">
          <text fg={item().warn ? theme.warning : theme.textMuted} wrapMode="none" truncate>
            {item().label}
            {item().warn ? " · /compact to trim" : ""}
          </text>
        </box>
      )}
    </Show>
  )
}
