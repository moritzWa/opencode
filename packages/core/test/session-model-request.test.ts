import { describe, expect, test } from "bun:test"
import { LLM, Message, ToolCallPart, ToolResultPart, Media } from "@opencode/ai"
import { Anthropic, OpenAI } from "@opencode/ai/providers"
import { compileRequest } from "@opencode/ai/route/client"
import { boundImages, unsupportedParts } from "@opencode/core/session/model-request"
import { Effect } from "effect"
import { it } from "./lib/effect"

const capabilities = (input: string[]) => ({ tools: true, input, output: ["text"] })

describe("SessionModelRequest.unsupportedParts", () => {
  it.effect("compiles poisoned archive history for both Anthropic Messages and OpenAI Responses", () =>
    Effect.gen(function* () {
      const messages = [
        Message.user("Read this Slack zip"),
        Message.assistant(ToolCallPart.make({ id: "slack_zip", name: "execute", input: {} })),
        Message.tool({
          id: "slack_zip",
          name: "execute",
          resultType: "content",
          result: [
            { type: "text", text: "Arca-Copilot-Demo-Kit.zip" },
            { type: "file", uri: "data:application/zip;base64,UEsDBA==", mime: "application/zip" },
          ],
        }),
        Message.user("continue"),
      ]
      for (const model of [
        Anthropic.configure({ apiKey: "fixture" }).model("claude-sonnet-4-5"),
        OpenAI.configure({ apiKey: "fixture" }).responses("gpt-5.4"),
      ]) {
        const prepared = yield* compileRequest(
          LLM.request({
            model,
            messages: unsupportedParts(messages, capabilities(["text", "image", "pdf"]), model.provider),
          }),
        )
        const body = JSON.stringify(prepared.body)
        expect(body).toContain("application/zip")
        expect(body).toContain("Download it to disk")
        expect(body).not.toContain("data:application/zip")
        expect(body).not.toContain("UEsDBA==")
      }
    }),
  )

  test.each(["anthropic", "openai"])("keeps archived tool results from poisoning %s requests", (provider) => {
    const zip = { type: "file" as const, uri: "data:application/zip;base64,UEsDBA==", mime: "application/zip" }
    const messages = [
      Message.tool(
        ToolResultPart.make({
          id: "slack_zip",
          name: "execute",
          result: { type: "content", value: [{ type: "text", text: "File: report.zip" }, zip] },
        }),
      ),
      Message.user("continue"),
    ]
    const result = unsupportedParts(messages, capabilities(["text", "image", "pdf"]), provider)
    expect(result[0]?.content[0]).toMatchObject({
      type: "tool-result",
      id: "slack_zip",
      name: "execute",
      result: {
        type: "content",
        value: [
          { type: "text", text: "File: report.zip" },
          { type: "text", text: expect.stringContaining("application/zip") },
        ],
      },
    })
    expect(JSON.stringify(result)).not.toContain("UEsDBA==")
    expect(messages[0]?.content[0]).toMatchObject({ result: { value: [{ type: "text" }, zip] } })
    expect(result[1]).toBe(messages[1])
  })

  test("replaces unknown user binaries while preserving supported text documents", () => {
    const text = Message.user({ type: "media", media: Media.base64("aGVsbG8=", "text/plain") })
    const result = unsupportedParts(
      [
        Message.user({ type: "media", media: Media.base64("UEsDBA==", "APPLICATION/ZIP"), filename: "report.zip" }),
        Message.user({ type: "media", media: Media.base64("AA==", "application/octet-stream") }),
        text,
      ],
      capabilities(["text", "image", "pdf"]),
    )
    expect(result[0]?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining('"report.zip"') })
    expect(result[1]?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("application/octet-stream"),
    })
    expect(result[2]).toBe(text)
  })

  test("replaces unsupported user media with a visible error", () => {
    const messages = unsupportedParts(
      [
        Message.user([
          Message.text("Describe these files"),
          { type: "media", media: Media.base64("aGVsbG8=", "image/png"), filename: "logo.png" },
          { type: "media", media: Media.base64("JVBERg==", "application/pdf"), filename: "document.pdf" },
        ]),
      ],
      capabilities(["text"]),
    )

    expect(messages[0]?.content).toEqual([
      Message.text("Describe these files"),
      Message.text('ERROR: Cannot read "logo.png" (this model does not support image input). Inform the user.'),
      Message.text('ERROR: Cannot read "document.pdf" (this model does not support pdf input). Inform the user.'),
    ])
  })

  test("replaces unsupported media nested in tool results", () => {
    const messages = unsupportedParts(
      [
        Message.tool(
          ToolResultPart.make({
            id: "call_1",
            name: "read",
            result: {
              type: "content",
              value: [
                { type: "text", text: "Image read successfully" },
                { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "logo.png" },
              ],
            },
          }),
        ),
      ],
      capabilities(["text"]),
    )

    expect(messages[0]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [
          { type: "text", text: "Image read successfully" },
          {
            type: "text",
            text: 'ERROR: Cannot read "logo.png" (this model does not support image input). Inform the user.',
          },
        ],
      },
    })
  })

  test("replaces images xAI cannot decode and keeps png, jpeg and webp", () => {
    const image = (mime: string, name: string) => ({
      type: "media" as const,
      media: Media.base64("aGVsbG8=", mime),
      filename: name,
    })
    const user = [image("image/png", "a.png"), image("image/jpeg", "b.jpg"), image("image/webp", "c.webp")]
    const messages = [
      Message.user([...user, image("image/gif", "d.gif")]),
      Message.tool(
        ToolResultPart.make({
          id: "call_1",
          name: "read",
          result: {
            type: "content",
            value: [
              { type: "text", text: "Image read successfully" },
              { type: "file", uri: "data:image/gif;base64,R0lGODlh", mime: "image/gif", name: "e.gif" },
            ],
          },
        }),
      ),
    ]
    const result = unsupportedParts(messages, capabilities(["text", "image"]), "xai")

    expect(result[0]?.content).toEqual([
      ...user,
      Message.text('ERROR: Cannot read "d.gif" (this model does not support image/gif input). Inform the user.'),
    ])
    expect(result[1]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [
          { type: "text", text: "Image read successfully" },
          {
            type: "text",
            text: 'ERROR: Cannot read "e.gif" (this model does not support image/gif input). Inform the user.',
          },
        ],
      },
    })
    expect(unsupportedParts(messages, capabilities(["text", "image"]), "openai")).toEqual(messages)
  })

  test("preserves supported media", () => {
    const message = Message.user({ type: "media", media: Media.base64("aGVsbG8=", "image/png") })
    expect(unsupportedParts([message], capabilities(["text", "image"]))[0]?.content).toEqual(message.content)
  })

  test("returns the same messages when nothing is unsupported", () => {
    const messages = [
      Message.user([Message.text("hi"), { type: "media", media: Media.base64("aGVsbG8=", "image/png") }]),
      Message.assistant("hello"),
      Message.tool(
        ToolResultPart.make({
          id: "call_1",
          name: "read",
          result: {
            type: "content",
            value: [{ type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "logo.png" }],
          },
        }),
      ),
    ]
    const result = unsupportedParts(messages, capabilities(["text", "image"]))
    expect(result).toHaveLength(messages.length)
    result.forEach((message, index) => expect(message).toBe(messages[index]))
  })

  test("rebuilds only messages with unsupported media", () => {
    const text = Message.user("plain")
    const supported = Message.tool(
      ToolResultPart.make({
        id: "call_1",
        name: "read",
        result: { type: "content", value: [{ type: "text", text: "no files" }] },
      }),
    )
    const tool = ToolResultPart.make({
      id: "call_2",
      name: "read",
      result: {
        type: "content",
        value: [
          { type: "text", text: "Read" },
          { type: "file", uri: "data:application/pdf;base64,JVBERg==", mime: "application/pdf" },
        ],
      },
    })
    const unsupported = Message.make({ role: "tool", content: [tool, Message.text("caption")] })
    const result = unsupportedParts([text, supported, unsupported], capabilities(["text"]))

    expect(result[0]).toBe(text)
    expect(result[1]).toBe(supported)
    expect(result[2]).not.toBe(unsupported)
    expect(result[2]).toBeInstanceOf(Message)
    expect(result[2]?.content[1]).toEqual(Message.text("caption"))
    expect(result[2]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [
          { type: "text", text: "Read" },
          { type: "text", text: "ERROR: Cannot read pdf (this model does not support pdf input). Inform the user." },
        ],
      },
    })
    expect(tool.result).toMatchObject({
      type: "content",
      value: [
        { type: "text", text: "Read" },
        { type: "file", mime: "application/pdf" },
      ],
    })
  })
})

describe("SessionModelRequest.boundImages", () => {
  test("preserves images below the trigger", () => {
    const messages = [Message.user({ type: "media", media: Media.base64("aGVsbG8=", "image/png") })]
    expect(boundImages(messages)).toBe(messages)
  })

  test("replaces oldest images until the retained payload reaches the target", () => {
    const image = "a".repeat(9 * 1024 * 1024)
    const text = Message.user("plain")
    const third = Message.user({ type: "media", media: Media.base64(image, "image/png"), filename: "third.png" })
    const messages = [
      Message.user({ type: "media", media: Media.base64(image, "image/png"), filename: "first.png" }),
      text,
      Message.user({ type: "media", media: Media.base64(image, "image/png"), filename: "second.png" }),
      third,
    ]
    const result = boundImages(messages)

    expect(result[0]).toBeInstanceOf(Message)
    expect(result[0]?.content).toEqual([Message.text(expect.stringContaining("image was removed"))])
    expect(result[1]).toBe(text)
    expect(result[2]).not.toBe(messages[2])
    expect(result[2]?.content[0]).toMatchObject({ type: "text" })
    expect(result[3]).toBe(third)
  })

  test("replaces images nested in tool results", () => {
    const image = "a".repeat(13 * 1024 * 1024)
    const result = boundImages([
      Message.tool(
        ToolResultPart.make({
          id: "call_1",
          name: "read",
          result: {
            type: "content",
            value: [
              { type: "file", uri: `data:image/png;base64,${image}`, mime: "image/png", name: "first.png" },
              { type: "file", uri: `data:image/png;base64,${image}`, mime: "image/png", name: "second.png" },
            ],
          },
        }),
      ),
    ])

    expect(result[0]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [{ type: "text" }, { type: "file", name: "second.png" }],
      },
    })
  })
})
