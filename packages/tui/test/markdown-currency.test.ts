import { afterAll, expect, test } from "bun:test"
import {
  CodeRenderable,
  MarkdownRenderable,
  SyntaxStyle,
  TextAttributes,
  TreeSitterClient,
  type Renderable,
} from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { tmpdir } from "./fixture/fixture"

const directory = await tmpdir()
const client = new TreeSitterClient({ dataPath: directory.path })
const syntaxStyle = SyntaxStyle.fromStyles({
  default: { fg: "#ffffff" },
  "markup.strong": { fg: "#ffffff", bold: true },
})

afterAll(async () => {
  await client.destroy()
  syntaxStyle.destroy()
  await directory[Symbol.asyncDispose]()
})

const examples = [
  {
    source: "splitting is **$94.68 each** ($79.68 + $15), not $89.68.",
    text: "splitting is $94.68 each ($79.68 + $15), not $89.68.",
    bold: "$94.68 each",
  },
  {
    source: "- **Conrad: $176.67** = $151.67 electricity + $15 Wi-Fi + $10 November Wi-Fi.",
    text: "Conrad: $176.67 = $151.67 electricity + $15 Wi-Fi + $10 November Wi-Fi.",
    bold: "Conrad: $176.67",
  },
  {
    source: "- **Mark: $10** for November Wi-Fi.",
    text: "Mark: $10 for November Wi-Fi.",
    bold: "Mark: $10",
  },
]

test.each(examples)("recognizes bold currency: $bold", async (example) => {
  const result = await client.highlightOnce(example.source, "markdown")
  expect(result.error).toBeUndefined()
  expect(
    result.highlights?.some(
      ([start, end, group]) => group === "markup.strong" && example.source.slice(start, end) === `**${example.bold}**`,
    ),
  ).toBe(true)
})

test.each([
  { width: 44, streaming: true },
  { width: 100, streaming: true },
  { width: 44, streaming: false },
  { width: 100, streaming: false },
])("renders currency after highlighting: %j", async ({ width, streaming }) => {
  const setup = await createTestRenderer({ width, height: 20, remote: true, useThread: false })
  try {
    const source = examples.map((example) => example.source).join("\n\n")
    const markdown = new MarkdownRenderable(setup.renderer, {
      content: source,
      syntaxStyle,
      treeSitterClient: client,
      streaming,
      internalBlockMode: "top-level",
      conceal: true,
      width: "100%",
    })
    setup.renderer.root.add(markdown)
    await setup.renderOnce()
    await Promise.all(blocks(markdown).map((block) => block.highlightingDone))
    await setup.renderOnce()
    const frame = setup.captureCharFrame().replace(/\s+/g, " ")
    expect(frame).not.toContain("**")
    examples.forEach((example) => expect(frame).toContain(example.text))
    expect(markdown.content).toBe(source)
    const bold = setup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .filter((chunk) => (chunk.attributes ?? 0) & TextAttributes.BOLD)
      .map((chunk) => chunk.text)
      .join("")
    examples.forEach((example) => expect(bold).toContain(example.bold))
  } finally {
    setup.renderer.destroy()
  }
})

test("leaves code, formulas, links and raw Markdown intact", async () => {
  const setup = await createTestRenderer({ width: 100, height: 20, remote: true, useThread: false })
  try {
    const source = [
      "**Pay $10** then $20. Keep `$HOME` and `$10 + $20` literal.",
      "Formula: $x + y$ and $$x^2$$. [Price $10](https://example.com/$20).",
      '```sh\necho "$HOME" # $10 + $20\n```',
    ].join("\n\n")
    const markdown = new MarkdownRenderable(setup.renderer, {
      content: source,
      syntaxStyle,
      treeSitterClient: client,
      streaming: false,
      internalBlockMode: "top-level",
      conceal: true,
      width: "100%",
    })
    setup.renderer.root.add(markdown)
    await setup.renderOnce()
    await Promise.all(blocks(markdown).map((block) => block.highlightingDone))
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Pay $10 then $20. Keep $HOME and $10 + $20 literal.")
    expect(setup.captureCharFrame()).toContain("Formula: $x + y$ and $$x^2$$.")
    expect(setup.captureCharFrame()).toContain("Price $10")
    expect(setup.captureCharFrame()).toContain('echo "$HOME" # $10 + $20')
    expect(markdown.content).toBe(source)

    markdown.conceal = false
    await setup.renderOnce()
    await Promise.all(blocks(markdown).map((block) => block.highlightingDone))
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("**Pay $10** then $20. Keep `$HOME` and `$10 + $20` literal.")
    expect(setup.captureCharFrame()).toContain("[Price $10](https://example.com/$20)")
  } finally {
    setup.renderer.destroy()
  }
})

function blocks(node: Renderable): CodeRenderable[] {
  return [...(node instanceof CodeRenderable ? [node] : []), ...node.getChildren().flatMap(blocks)]
}
