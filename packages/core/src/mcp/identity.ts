export * as McpIdentity from "./identity.js"

import { createHash } from "node:crypto"

/** The same URL under different configured names may represent different accounts. */
export function id(name: string, serverUrl: string) {
  return (
    "mcp_" +
    createHash("sha1")
      .update(name + "\u0000" + serverUrl)
      .digest("hex")
      .slice(0, 16)
  )
}
