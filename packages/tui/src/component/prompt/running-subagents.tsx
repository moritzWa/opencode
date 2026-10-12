import type { Session, SessionStatus } from "@opencode-ai/sdk/v2"
import { For, Show } from "solid-js"
import { Spinner } from "../spinner"
import { useRoute } from "../../context/route"
import { useTheme } from "../../context/theme"
import { Locale } from "../../util/locale"

export type RunningSubagent = { id: string; title: string }

export function runningSubagents(
  sessions: ReadonlyArray<Session>,
  status: Record<string, SessionStatus | undefined>,
  parentID: string,
): RunningSubagent[] {
  return sessions
    .filter((session) => session.parentID === parentID && status[session.id] && status[session.id]?.type !== "idle")
    .toSorted((a, b) => a.time.created - b.time.created)
    .map((session) => ({ id: session.id, title: session.title.replace(/ \(@[\w-]+ subagent\)$/, "") }))
}

export function RunningSubagents(props: { list: RunningSubagent[] }) {
  const route = useRoute()
  const { theme } = useTheme()
  const open = (sessionID: string) => route.navigate({ type: "session", sessionID })

  return (
    <box flexDirection="row" gap={2} flexShrink={1} minWidth={0}>
      <Show
        when={props.list.length <= 2}
        fallback={
          <box minWidth={0} flexShrink={1} overflow="hidden" onMouseUp={() => open(props.list[0].id)}>
            <text fg={theme.textMuted} wrapMode="none" truncate>
              {props.list.length} subagents
            </text>
          </box>
        }
      >
        <For each={props.list}>
          {(item) => (
            <box
              minWidth={0}
              flexShrink={1}
              flexDirection="row"
              gap={1}
              overflow="hidden"
              onMouseUp={() => open(item.id)}
            >
              <box flexShrink={0}>
                <Spinner color={theme.textMuted} />
              </box>
              <text fg={theme.textMuted} wrapMode="none" truncate>
                {Locale.truncate(item.title, props.list.length === 1 ? 40 : 24)}
              </text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}
