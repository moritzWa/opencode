/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { MarkdownRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { DEFAULT_THEMES, generateSyntax, resolveTheme, tint } from "../../src/theme"
import { build, source } from "../../src/feature-plugins/speech/script"
import { blocks, clear, offsetAt, register, show } from "../../src/feature-plugins/speech/view"

const content = `## Summary

I found the **likely bug** in \`router.ts\`. There are no tests for it.

- first item
- second item

\`\`\`ts
const skipped = true
\`\`\`

| a | b |
| - | - |
| 1 | 2 |

Final paragraph here.`

test("highlights the current sentence and word inside rendered markdown", async () => {
  const theme = resolveTheme(DEFAULT_THEMES.opencode, "dark")
  let view: MarkdownRenderable | undefined
  const setup = await testRender(
    () => (
      <markdown
        ref={(el: MarkdownRenderable) => (view = el)}
        syntaxStyle={generateSyntax(theme)}
        internalBlockMode="top-level"
        conceal={true}
        content={content}
      />
    ),
    { width: 70, height: 20 },
  )
  const settle = async (ok: () => boolean) => {
    const start = performance.now()
    while (!ok() && performance.now() - start < 3000) {
      await Bun.sleep(16)
      await setup.renderOnce()
    }
    return ok()
  }
  const painted = (rgb: { r: number; g: number; b: number }) =>
    setup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .filter((span) => {
        const [r, g, b] = span.bg.buffer
        return Math.abs(r - rgb.r * 255) < 2 && Math.abs(g - rgb.g * 255) < 2 && Math.abs(b - rgb.b * 255) < 2
      })
      .map((span) => span.text)
      .join("")

  try {
    await setup.renderOnce()
    expect(await settle(() => setup.captureCharFrame().includes("likely bug"))).toBe(true)
    register("part", view!)
    const nodes = blocks("part")!
    expect(nodes.map((node) => node.content)).toEqual([
      "## Summary",
      "I found the **likely bug** in `router.ts`. There are no tests for it.",
      "first item",
      "second item",
      "Final paragraph here.",
    ])

    const script = build(nodes.map((node) => node.content))
    const word = script.words.findIndex((w) => script.text.slice(w.start, w.end) === "tests")
    const sentence = script.sentences.find(
      (s) => s.start <= script.words[word].start && script.words[word].end <= s.end,
    )!
    const target = source(script, script.words[word])
    show(nodes[target.segment], source(script, sentence), target)
    const wordColor = tint(theme.background, theme.primary, 0.4)
    const sentenceColor = tint(theme.background, theme.primary, 0.12)

    expect(await settle(() => painted(wordColor).includes("tests"))).toBe(true)
    expect(painted(wordColor).trim()).toBe("tests")
    expect(painted(sentenceColor)).toContain("There are no")
    expect(painted(sentenceColor)).not.toContain("likely")

    clear()
    expect(await settle(() => !painted(wordColor).includes("tests"))).toBe(true)
  } finally {
    await Bun.sleep(50)
    setup.renderer.destroy()
  }
}, 20000)

test("maps a clicked cell to its offset in the block's raw markdown", async () => {
  const theme = resolveTheme(DEFAULT_THEMES.opencode, "dark")
  let view: MarkdownRenderable | undefined
  const setup = await testRender(
    () => (
      <markdown
        ref={(el: MarkdownRenderable) => (view = el)}
        syntaxStyle={generateSyntax(theme)}
        internalBlockMode="top-level"
        conceal={true}
        content={
          "I found the **likely bug** in `router.ts` and a [link](https://x.com/a) there. There are no tests\nfor it at all, which is a shame.\n\n- first **item** here"
        }
      />
    ),
    { width: 40, height: 12 },
  )
  try {
    for (let i = 0; i < 30 && !setup.captureCharFrame().includes("shame"); i++) {
      await Bun.sleep(16)
      await setup.renderOnce()
    }
    register("click", view!)
    const frame = setup.captureCharFrame().split("\n")
    const at = (word: string) => {
      const y = frame.findIndex((row) => new RegExp(`\\b${word}\\b`).test(row))
      const x = frame[y].search(new RegExp(`\\b${word}\\b`)) + 1
      const node = blocks("click")!.find((node) => y >= node.y && y < node.y + node.height)!
      const offset = offsetAt(node, x, y)!
      return node.content.slice(offset, offset + word.length - 1)
    }
    expect(at("likely")).toBe("ikely")
    expect(at("router")).toBe("outer")
    expect(at("there")).toBe("here")
    expect(at("shame")).toBe("hame")
    expect(at("item")).toBe("tem")
  } finally {
    await Bun.sleep(50)
    setup.renderer.destroy()
  }
}, 20000)
