import type { JSX } from "solid-js"
import type { CliRenderer, MouseEvent, RGBA } from "@opentui/core"
import { existsSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { openPath, openUrl } from "@opencode/util/open"

export interface LinkProps {
  href: string
  children?: JSX.Element | string
  fg?: RGBA
  bg?: RGBA
  width?: number | "auto" | `${number}%`
  wrapMode?: "word" | "none"
}

/**
 * Link component that renders clickable hyperlinks.
 * Clicking anywhere on the link text opens the URL in the default browser.
 */
export function Link(props: LinkProps) {
  const displayText = props.children ?? props.href

  return (
    <text
      fg={props.fg}
      bg={props.bg}
      width={props.width}
      wrapMode={props.wrapMode}
      onMouseUp={() => {
        openUrl(props.href).catch(() => {})
      }}
    >
      <a href={props.href}>{displayText}</a>
    </text>
  )
}

/**
 * Returns the hyperlink under a plain left click. opentui marks the release that ends a selection gesture with
 * `isDragging`, and a fresh "cell" selection means the pointer never moved; other releases, such as the end of a drag
 * that started outside text, are not clicks. Each rendered cell stores its full URL, so a click on any row of a wrapped
 * link resolves the whole link. Modified clicks are left to the terminal's own hyperlink handling.
 */
export function clickedLink(renderer: CliRenderer, event: MouseEvent) {
  if (!isPlainClick(renderer, event)) return
  return renderer.getLinkAt(event.x, event.y) ?? undefined
}

/**
 * Returns the existing local file or directory written as plain text under a plain left click, such as
 * `~/Desktop/report.xlsx` or `/Users/me/My\ Files/a.png`. Text that does not name something on disk is not a link.
 */
export function clickedPath(renderer: CliRenderer, event: MouseEvent, directory: string) {
  if (!isPlainClick(renderer, event) || event.x < 0 || event.y < 0) return
  const row = new TextDecoder().decode(renderer.currentRenderBuffer.getRealCharBytes(true)).split("\n")[event.y]
  if (!row) return
  let column = 0
  let index = 0
  for (const char of row) {
    column += Bun.stringWidth(char)
    if (column > event.x) break
    index += char.length
  }
  const words = [...row.matchAll(/(?:\\.|\S)+/g)].map((match) => ({ start: match.index, end: match.index + match[0].length }))
  const matches = words.flatMap((first, at) => {
    if (first.start > index || !/^[`"'(\[<]*(?:~|\.{0,2})?\//.test(row.slice(first.start, first.end))) return []
    // Unescaped spaces are common in pasted paths, so try each longer run of words and keep the longest match.
    return words.slice(at, at + 8).flatMap((last) => {
      if (last.end <= index) return []
      const found = existingPath(row.slice(first.start, last.end), directory)
      return found ? [{ found, length: last.end - first.start }] : []
    })
  })
  return matches.toSorted((a, b) => b.length - a.length)[0]?.found
}

export function openLink(target: string, directory: string) {
  if (/^https?:\/\//i.test(target)) return openUrl(target)
  const found = existingPath(target, directory)
  if (!found) return Promise.reject(new Error(`No such file or directory: ${target}`))
  return openLocalPath(found)
}

export function openLocalPath(target: string) {
  const info = statSync(target)
  // `open` runs applications, scripts and unix executables rather than showing them.
  const extension = path.extname(target).slice(1).toLowerCase()
  if (OPENS_AS_PROGRAM.has(extension) || (!extension && info.isFile() && info.mode & 0o111))
    return Promise.reject(new Error(`Not opening a program from a link: ${target}`))
  return openPath(target)
}

const OPENS_AS_PROGRAM = new Set([
  "app",
  "command",
  "tool",
  "terminal",
  "workflow",
  "action",
  "scpt",
  "scptd",
  "pkg",
  "mpkg",
  "dmg",
  "sh",
  "zsh",
  "bash",
  "csh",
  "ps1",
  "bat",
  "cmd",
  "exe",
  "msi",
  "jar",
  "vbs",
  "prefpane",
  "saver",
])

function isPlainClick(renderer: CliRenderer, event: MouseEvent) {
  if (!event.isDragging || event.modifiers.ctrl || event.modifiers.alt || event.modifiers.shift) return false
  const selection = renderer.getSelection()
  return !!selection?.isStart && selection.behavior === "cell"
}

function existingPath(text: string, directory: string) {
  const cleaned = text
    .replace(/^[`"'(\[<]+/, "")
    .replace(/[`"')\]>.,;:!?]+$/, "")
    .replace(/\\(.)/g, "$1")
  const value = cleaned.startsWith("file://") && URL.canParse(cleaned) ? fileURLToPath(cleaned) : cleaned
  if (!value) return
  const candidates = path.isAbsolute(value)
    ? [value]
    : value === "~" || value.startsWith("~/")
      ? [path.join(os.homedir(), value.slice(1))]
      : [path.resolve(directory, value), path.resolve(os.homedir(), value)]
  return candidates.find((candidate) => existsSync(candidate))
}
