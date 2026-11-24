import { expect, test } from "bun:test"
import {
  CodeRenderable,
  MarkdownRenderable,
  SyntaxStyle,
  TextRenderable,
  type MarkdownCodeBlockRenderer,
} from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { render } from "@opentui/solid"
import { createRoot, createSignal } from "solid-js"
import { createMarkdownRenderer } from "../src/plugin/markdown"
import { waitForHighlightedFrame } from "./fixture/frame"

// Fences must have a visible fallback before highlighting, including languages
// such as `text` that have no syntax parser. These tests inspect actual cells.
for (const streaming of [false, true]) {
  for (const [name, content] of [
    ["top-level", 'Before\n\n```text\nrm -rf "/Volumes/Data/Library/Bluetooth/"*\n```\n\nAfter'],
    [
      "numbered",
      '3. Paste only this line:\n\n   ```text\n   rm -rf "/Volumes/Data/Library/Bluetooth/"*\n   ```\n\n4. After',
    ],
    [
      "bulleted",
      '- Paste only this line:\n\n  ```text\n  rm -rf "/Volumes/Data/Library/Bluetooth/"*\n  ```\n\n- After',
    ],
  ]) {
    test(`${name} fences remain visible with streaming=${streaming}`, async () => {
      const output = await createTestRenderer({ width: 80, height: 18, remote: true })
      await render(() => {
        const renderNode = createMarkdownRenderer(() => [])
        return (
          <markdown
            syntaxStyle={SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } }, output.renderer.nativeScene)}
            renderBlock={renderNode()}
            content={content}
            streaming={streaming}
          />
        )
      }, output.renderer)
      try {
        output.renderer.start()
        await waitForHighlightedFrame(output, (frame) => frame.includes('rm -rf "/Volumes/Data/Library/Bluetooth/"*'))
        expect(output.captureCharFrame()).toContain('rm -rf "/Volumes/Data/Library/Bluetooth/"*')
      } finally {
        output.renderer.destroy()
      }
    })
  }
}

test("list fences stay visible through streamed edits, restyling, and completion", async () => {
  const output = await createTestRenderer({ width: 80, height: 24, remote: true })
  const [content, setContent] = createSignal("1. Paste `this`:\n\n   ```text\n   first")
  const [streaming, setStreaming] = createSignal(true)
  const [style, setStyle] = createSignal(
    SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } }, output.renderer.nativeScene),
  )
  await render(() => {
    const renderNode = createMarkdownRenderer(() => [])
    return <markdown syntaxStyle={style()} renderBlock={renderNode()} content={content()} streaming={streaming()} />
  }, output.renderer)
  try {
    output.renderer.start()
    await waitForHighlightedFrame(output, (frame) => frame.includes("first"))
    expect(output.captureCharFrame()).toContain("first")
    setContent("1. Paste `this`:\n\n   ```text\n   first second\n   ```\n\n2. After")
    await waitForHighlightedFrame(output, (frame) => frame.includes("first second"))
    expect(output.captureCharFrame()).toContain("first second")
    setStyle(SyntaxStyle.fromStyles({ default: { fg: "#aabbff" } }, output.renderer.nativeScene))
    await output.renderOnce()
    expect(output.captureCharFrame()).toContain("first second")
    setStreaming(false)
    await output.renderOnce()
    expect(output.captureCharFrame()).toContain("first second")
    expect(output.captureCharFrame()).toContain("2. After")

    for (const language of ["", "unknown-language", "bash", "javascript"]) {
      setStreaming(true)
      setContent(`- Outer\n  - Inner\n\n    \`\`\`${language}\n    visible_code()\n    \`\`\`\n\n- After`)
      await waitForHighlightedFrame(output, (frame) => frame.includes("visible_code()"))
      expect(output.captureCharFrame()).toContain("visible_code()")
    }
  } finally {
    output.renderer.destroy()
  }
})

test("unrelated plugin toggles preserve mounted Markdown blocks", async () => {
  const output = await createTestRenderer({ width: 80, height: 12, remote: true })
  const handler: MarkdownCodeBlockRenderer = () =>
    new TextRenderable(output.renderer, { content: "Custom fence", height: 1 })
  const [sources, setSources] = createSignal<ReadonlyArray<Readonly<Record<string, MarkdownCodeBlockRenderer>>>>([
    { example: handler },
    {},
  ])
  await render(() => {
    const renderBlock = createMarkdownRenderer(sources)
    return (
      <markdown
        syntaxStyle={SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } }, output.renderer.nativeScene)}
        renderBlock={renderBlock()}
        content={"A plain paragraph.\n\n```example\nFence content\n```"}
        streaming={false}
      />
    )
  }, output.renderer)
  try {
    output.renderer.start()
    await output.waitForFrame((frame) => frame.includes("Custom fence"))
    const markdown = output.renderer.root.getChildren()[0]
    if (!(markdown instanceof MarkdownRenderable)) throw new Error("Expected Markdown")
    const initial = markdown.getChildren()
    expect(initial).toHaveLength(2)
    expect(output.captureCharFrame()).toContain("Custom fence")

    for (const active of [false, true, false, true]) {
      setSources([{ example: handler }, ...(active ? [{}] : [])])
      await output.renderOnce()
      expect(markdown.getChildren()[0] === initial[0]).toBe(true)
      expect(markdown.getChildren()[1] === initial[1]).toBe(true)
      expect(initial.every((block) => !block.isDestroyed)).toBe(true)
    }
  } finally {
    output.renderer.destroy()
  }
})

test("effective mappings preserve identity through reordered and shadowed contributions", () => {
  createRoot((dispose) => {
    try {
      const first: MarkdownCodeBlockRenderer = () => undefined
      const second: MarkdownCodeBlockRenderer = () => undefined
      const [sources, setSources] = createSignal<ReadonlyArray<Readonly<Record<string, MarkdownCodeBlockRenderer>>>>([
        { example: first },
        { example: second, other: first },
      ])
      const renderBlock = createMarkdownRenderer(sources)
      const initial = renderBlock()

      setSources([{ other: first, example: second }])
      expect(renderBlock()).toBe(initial)
      setSources([{ example: first }, { other: first, example: second }])
      expect(renderBlock()).toBe(initial)

      setSources([{ example: first, other: first }])
      expect(renderBlock()).not.toBe(initial)
      setSources([])
      expect(renderBlock()).toBeUndefined()
    } finally {
      dispose()
    }
  })
})

test("unordered lists use filled bullets while numbered lists retain their numbers", async () => {
  const output = await createTestRenderer({ width: 80, height: 12, remote: true })
  await render(() => {
    const renderNode = createMarkdownRenderer(() => [])
    return (
      <markdown
        syntaxStyle={SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } }, output.renderer.nativeScene)}
        renderBlock={renderNode()}
        content={"- alpha\n- beta\n\n1. one\n2. two"}
        streaming={false}
      />
    )
  }, output.renderer)
  try {
    output.renderer.start()
    await output.waitForFrame((frame) => frame.includes("alpha") && frame.includes("two"))
    expect(output.captureCharFrame()).toContain("● alpha")
    expect(output.captureCharFrame()).toContain("● beta")
    expect(output.captureCharFrame()).toContain("1. one")
    expect(output.captureCharFrame()).toContain("2. two")
  } finally {
    output.renderer.destroy()
  }
})

test("changing and removing a Markdown handler refreshes existing messages", async () => {
  const output = await createTestRenderer({ width: 80, height: 12, remote: true })
  const first: MarkdownCodeBlockRenderer = () =>
    new TextRenderable(output.renderer, { content: "First renderer", height: 1 })
  const second: MarkdownCodeBlockRenderer = () =>
    new TextRenderable(output.renderer, { content: "Second renderer", height: 1 })
  const [sources, setSources] = createSignal<ReadonlyArray<Readonly<Record<string, MarkdownCodeBlockRenderer>>>>([
    { example: first },
  ])
  await render(() => {
    const renderBlock = createMarkdownRenderer(sources)
    return (
      <markdown
        syntaxStyle={SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } }, output.renderer.nativeScene)}
        renderBlock={renderBlock()}
        content={"```example\nFence content\n```"}
        streaming={false}
      />
    )
  }, output.renderer)
  try {
    output.renderer.start()
    await output.waitForFrame((frame) => frame.includes("First renderer"))

    setSources([{ example: first }, { example: second }])
    await output.waitForFrame((frame) => frame.includes("Second renderer"))

    setSources([{ example: first }])
    await output.waitForFrame((frame) => frame.includes("First renderer"))

    setSources([])
    await output.waitForFrame((frame) => frame.includes("Fence content"))
    expect(output.renderer.root.getChildren()[0]?.getChildren()[0]).toBeInstanceOf(CodeRenderable)

    setSources([{ example: second }])
    await output.waitForFrame((frame) => frame.includes("Second renderer"))
  } finally {
    output.renderer.destroy()
  }
})
