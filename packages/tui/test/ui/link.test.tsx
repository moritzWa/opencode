/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { SyntaxStyle } from "@opentui/core"
import { ManualClock } from "@opentui/core/testing"
import { testRender, useRenderer } from "@opentui/solid"
import { chmod, mkdir } from "node:fs/promises"
import path from "node:path"
import { clickedLink, clickedPath, openLink } from "../../src/ui/link"
import { tmpdir } from "../fixture/fixture"

const url = "https://example.com/catalog/moparts,2004,dodge,ram+1500,4.7l+v8,1432463,brake+pad"
const syntaxStyle = SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } })

test("plain clicks on any row of a wrapped Markdown link resolve the full URL", async () => {
  const opened: string[] = []
  function Transcript() {
    const renderer = useRenderer()
    return (
      <box
        onMouseUp={(event) => {
          const link = clickedLink(renderer, event)
          if (link) opened.push(link)
        }}
      >
        <box height={1} />
        <markdown syntaxStyle={syntaxStyle} content={`See ${url} now.`} />
      </box>
    )
  }
  const app = await testRender(() => <Transcript />, { width: 32, height: 6, clock: new ManualClock() })

  try {
    for (let attempt = 0; attempt < 50 && !app.captureCharFrame().replace(/\s/g, "").includes(url); attempt++) {
      await app.renderOnce()
      await Bun.sleep(10)
    }
    const rows = app.captureCharFrame().split("\n")
    const head = rows.findIndex((row) => row.includes("https"))
    const tail = rows.findIndex((row) => row.includes("brake+pad"))
    const x = rows[head]!.indexOf("https")
    expect(tail).toBeGreaterThan(head)

    await app.mockMouse.click(x, head)
    await app.mockMouse.click(rows[tail]!.indexOf("brake"), tail)
    expect(opened).toEqual([url, url])

    await app.mockMouse.click(0, head)
    await app.mockMouse.click(x, head, 0, { modifiers: { ctrl: true } })
    await app.mockMouse.click(x, head, 0, { modifiers: { shift: true } })
    await app.mockMouse.click(x, head, 2)
    await app.mockMouse.drag(0, head, x + 2, head)
    await app.mockMouse.drag(0, 0, x + 2, head)
    expect(opened).toEqual([url, url])

    await app.mockMouse.click(rows[tail]!.indexOf("brake"), tail)
    await app.mockMouse.click(rows[tail]!.indexOf("brake"), tail)
    expect(opened).toEqual([url, url, url])
  } finally {
    app.renderer.destroy()
  }
})

test("plain clicks on text naming an existing local path resolve it", async () => {
  await using root = await tmpdir()
  const sheet = path.join(root.path, "My Leads.xlsx")
  const folder = path.join(root.path, "dashboards-verify")
  await Bun.write(sheet, "a,b")
  await mkdir(folder)
  const clicked: (string | undefined)[] = []
  function Transcript() {
    const renderer = useRenderer()
    return (
      <box
        onMouseUp={(event) => {
          clicked.push(clickedPath(renderer, event, root.path))
        }}
      >
        <text>{`Sheet ${sheet.replaceAll(" ", "\\ ")} and ${folder}, then \`${sheet}\` or ${folder}/missing.csv`}</text>
        <text>{`Relative dashboards-verify/ and bogus/path here`}</text>
      </box>
    )
  }
  const app = await testRender(() => <Transcript />, { width: 400, height: 4, clock: new ManualClock() })

  try {
    await app.renderOnce()
    const rows = app.captureCharFrame().split("\n")
    const at = (row: number, text: string, offset = 1) => rows[row]!.indexOf(text) + offset

    await app.mockMouse.click(at(0, "My\\ Leads"), 0)
    await app.mockMouse.click(at(0, folder), 0)
    await app.mockMouse.click(at(0, "dashboards-verify,"), 0)
    await app.mockMouse.click(at(0, `\`${sheet}`, 2), 0)
    await app.mockMouse.click(at(0, "Sheet", 1), 0)
    await app.mockMouse.click(at(0, "missing.csv"), 0)
    await app.mockMouse.click(at(1, "dashboards-verify/"), 1)
    await app.mockMouse.click(at(1, "bogus"), 1)
    expect(clicked).toEqual([sheet, folder, folder, sheet, undefined, undefined, undefined, undefined])

    await app.mockMouse.click(at(0, folder), 0, 0, { modifiers: { shift: true } })
    await app.mockMouse.drag(at(0, folder), 0, at(0, folder) + 4, 0)
    expect(clicked.slice(8)).toEqual([undefined, undefined])
  } finally {
    app.renderer.destroy()
  }
})

test("local links open existing files and refuse programs and missing paths", async () => {
  await using root = await tmpdir()
  await mkdir(path.join(root.path, "Thing.app"))
  await Bun.write(path.join(root.path, "run"), "#!/bin/sh")
  await chmod(path.join(root.path, "run"), 0o755)
  await expect(openLink("Thing.app", root.path)).rejects.toThrow("Not opening a program")
  await expect(openLink(path.join(root.path, "run"), root.path)).rejects.toThrow("Not opening a program")
  await expect(openLink("nope/missing.xlsx", root.path)).rejects.toThrow("No such file or directory")
  await expect(openLink("ms-msdt:/id PCWDiagnostic", root.path)).rejects.toThrow("No such file or directory")
})
