import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export interface Credentials { accessToken: string; refreshToken: string; expiresAt: number }
export interface Account { source: string; configDir?: string; credentials: Credentials; label: string }
export interface CredentialStore {
  read(): Promise<Credentials | null>
  write(next: Credentials, previous: Credentials): Promise<boolean>
  lock?(): { release(): void } | null
}

export async function legacyPackageRoot(entry = fileURLToPath(import.meta.resolve("opencode-claude-auth"))) {
  let directory = dirname(entry)
  while (true) {
    const manifest = await Bun.file(join(directory, "package.json")).json().catch(() => undefined) as { name?: string; version?: string } | undefined
    if (manifest?.name === "opencode-claude-auth") {
      if (manifest.version !== "2.2.1") throw new Error("Claude subscription transport requires opencode-claude-auth 2.2.1")
      return directory
    }
    const parent = dirname(directory)
    if (parent === directory) throw new Error("Cannot locate pinned Claude subscription transport package root")
    directory = parent
  }
}

export async function legacy(root?: string) {
  const directory = root ?? await legacyPackageRoot()
  // Only pure transport transforms and Keychain access are reused. The V1 plugin,
  // its generic-429 refresh path, auth.json sync and background timers never run.
  const keychain = await import(pathToFileURL(join(directory, "dist/keychain.js")).href) as {
    readAllClaudeAccounts(): Account[]
    refreshAccount(source: string, configDir?: string): Credentials | null
    writeBackCredentials(source: string, next: Credentials, configDir?: string, expected?: string): boolean
  }
  const transport = await import(pathToFileURL(join(directory, "dist/index.js")).href) as {
    SYSTEM_IDENTITY: string
    buildRequestHeaders(input: Request, init: RequestInit, token: string, model: string, excluded?: Set<string>): Headers
    transformBody(body: string): string
    transformResponseStream(response: Response): Response
    getExcludedBetas(model: string): Set<string>
    isLongContextError(body: string): boolean
    getNextBetaToExclude(model: string): string | null
    addExcludedBeta(model: string, beta: string): void
    LONG_CONTEXT_BETAS: readonly string[]
  }
  const credentials = await import(pathToFileURL(join(directory, "dist/credentials.js")).href) as { loadPersistedAccountSource(): string | null }
  const locking = await import(pathToFileURL(join(directory, "dist/refresh-lock.js")).href) as { acquireRefreshLock(source: string): { release(): void } | null }
  return { keychain, transport, locking, preferredSource: credentials.loadPersistedAccountSource }
}

export function accountStore(source: Account, modules: Awaited<ReturnType<typeof legacy>>): CredentialStore {
  return {
    read: async () => modules.keychain.refreshAccount(source.source, source.configDir),
    write: async (next, previous) => modules.keychain.writeBackCredentials(source.source, next, source.configDir, previous.accessToken),
    lock: () => modules.locking.acquireRefreshLock(source.source),
  }
}
