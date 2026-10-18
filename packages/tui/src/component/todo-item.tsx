import { Option, Schema } from "effect"
import { useTheme } from "../context/theme"

const decode = Schema.decodeUnknownOption(
  Schema.Array(Schema.Struct({ content: Schema.String, status: Schema.String })),
)

export function parseTodos(value: unknown) {
  return Option.getOrElse(decode(value), () => [])
}

export function TodoItem(props: { content: string; status: string }) {
  const theme = useTheme()
  const color = () => (props.status === "in_progress" ? theme.text.feedback.warning.base : theme.text.muted)
  return (
    <box flexDirection="row">
      <text flexShrink={0} fg={color()}>
        [{props.status === "completed" ? "✓" : props.status === "in_progress" ? "•" : " "}]{" "}
      </text>
      <text flexGrow={1} wrapMode="word" fg={color()}>
        {props.content}
      </text>
    </box>
  )
}
