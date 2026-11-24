import { afterAll } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// The harness profile exports live config paths. Never discover those integrations in package tests.
// Windows AF_UNIX socket paths are bounded too. Avoid nesting another long home under the test launcher.
const home = realpathSync(
  mkdtempSync(
    path.join(process.platform === "win32" ? (process.env.RUNNER_TEMP ?? os.tmpdir()) : os.tmpdir(), "oc-home-"),
  ),
)
process.env.HOME = home
process.env.OPENCODE_TEST_HOME = home
process.env.XDG_CONFIG_HOME = path.join(home, ".config")
process.env.XDG_DATA_HOME = path.join(home, ".local", "share")
process.env.XDG_CACHE_HOME = path.join(home, ".cache")
process.env.XDG_STATE_HOME = path.join(home, ".local", "state")
process.env.OPENCODE_CONFIG_DIR = path.join(home, ".config", "opencode")
process.env.TMPDIR = path.join(home, "tmp")
if (process.platform === "win32") {
  process.env.USERPROFILE = home
  process.env.TMP = process.env.TMPDIR
  process.env.TEMP = process.env.TMPDIR
}
mkdirSync(process.env.TMPDIR)
for (const key of [
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
  "AWS_REGION",
  "GOOGLE_VERTEX_PROJECT",
  "NPM_CONFIG_REGISTRY",
  "UIDOTSH_AUTHORIZATION",
])
  delete process.env[key]
if (process.env.RECORD !== "true") delete process.env.OPENAI_API_KEY
afterAll(() => rm(home, { recursive: true, force: true }))

process.env.OPENCODE_DB = ":memory:"
process.env.NPM_CONFIG_AUDIT = "false"
