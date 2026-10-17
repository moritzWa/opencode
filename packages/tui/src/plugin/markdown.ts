import {
  createMarkdownCodeBlockRenderer,
  TextRenderable,
  StyledText,
  type MarkdownCodeBlockRenderer,
  type MarkdownOptions,
  type Renderable,
} from "@opentui/core"
import { isShallowEqual } from "remeda"
import { createMemo } from "solid-js"

export function createMarkdownRenderer(
  sources: () => ReadonlyArray<Readonly<Record<string, MarkdownCodeBlockRenderer>>>,
) {
  // Changing renderNode makes OpenTUI destroy and rebuild every Markdown block.
  // Only invalidate it when the effective last-wins language handlers change.
  const renderers = createMemo(
    () => Object.fromEntries(sources().flatMap((source) => Object.entries(source))),
    undefined,
    { equals: isShallowEqual },
  )
  return createMemo(() => {
    const code = createMarkdownCodeBlockRenderer(renderers())
    const render: NonNullable<MarkdownOptions["renderNode"]> = (token, context) => {
      if (token.type !== "list") return code?.(token, context)
      const node = context.defaultRender()
      if (node) {
        fillBullets(node)
        // Built-in list reconciliation reassigns marker chunks during streaming and restyling.
        node.onLifecyclePass = () => fillBullets(node)
      }
      return node
    }
    return render
  })
}

function fillBullets(node: Renderable) {
  if (
    node instanceof TextRenderable &&
    node.id.endsWith("-marker") &&
    node.chunks
      .map((chunk) => chunk.text)
      .join("")
      .trim() === "-"
  )
    node.content = new StyledText(node.chunks.map((chunk) => ({ ...chunk, text: chunk.text.replace("-", "●") })))
  node.getChildren().forEach((child) => fillBullets(child as Renderable))
}
