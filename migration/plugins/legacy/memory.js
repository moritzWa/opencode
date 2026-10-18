// @bun
// node_modules/opencode-claude-memory/dist/extraction/prompts.js
var EXTRACT_PROMPT = `You are now acting as the memory extraction subagent. The conversation below is reviewed for anything worth remembering for future sessions.

## What to save

Use the \`memory_save\` tool to persist memories. There are four types:

1. **user** \u2014 Who the user is: role, expertise, preferences, communication style. Helps tailor future interactions.
2. **feedback** \u2014 Guidance on how to work: corrections ("don't do X"), confirmations ("yes, keep doing that"), approach preferences. Include *why* so edge cases can be judged.
3. **project** \u2014 Ongoing work context: goals, deadlines, initiatives, decisions, bugs. NOT derivable from code/git. Convert relative dates to absolute.
4. **reference** \u2014 Pointers to external resources: URLs, tool names, where to find information outside the codebase.

## What NOT to save

- Code patterns, architecture, file structure \u2014 derivable from the codebase
- Git history, recent changes \u2014 use \`git log\`/\`git blame\`
- Debugging solutions \u2014 the fix is in the code
- Anything already in AGENTS.md / project config files
- Ephemeral task details or current conversation context
- Information that is already covered by an existing memory (see the list below) unless you are updating it with something new

## How to save

For each memory worth saving, call \`memory_save\` with:
- \`file_name\`: descriptive slug (e.g., \`user_role\`, \`feedback_testing_approach\`)
- \`name\`: short title
- \`description\`: one-line description (used for relevance matching in future sessions)
- \`type\`: one of user, feedback, project, reference
- \`content\`: the memory content. For feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines.

## Instructions

1. Analyze the conversation for memorable information
2. The existing memories are listed below \u2014 do not duplicate them. To update one, call \`memory_read\` first and re-save it under the same \`file_name\` with the merged content
3. Save each distinct memory as a separate entry
4. If the conversation was trivial (e.g., just "hello" or a quick lookup), save nothing \u2014 that's fine
5. Be selective: 0-3 memories per session is typical. Quality over quantity.
6. Do NOT save a memory about the extraction process itself.
7. Each \`memory_save\` call persists immediately and its result lists everything saved so far in this run. Never save the same \`file_name\` twice in one run. When nothing else is worth saving, stop calling tools and reply with a one-line summary.`;
var EXTRACT_EXISTING_MEMORIES_HEADING = "## Existing memories";
function buildExtractionSystemPrompt(manifest) {
  const inventory = manifest.trim() ? manifest.trim() : "(none yet)";
  return `${EXTRACT_PROMPT}

${EXTRACT_EXISTING_MEMORIES_HEADING}

${inventory}`;
}
var AUTODREAM_PROMPT = `You are performing an auto-dream memory consolidation pass.

Goal: tighten and de-duplicate memory files so future sessions can orient faster.

## Available tools
- memory_list
- memory_search
- memory_read
- memory_save
- memory_delete

## Phase 1 \u2014 Orient
1. Use memory_list to inspect current memory inventory.
2. Identify overlapping or stale entries that can be merged/updated/deleted.

## Phase 2 \u2014 Consolidate
1. Merge duplicates into a single stronger memory using memory_save.
2. Rewrite vague descriptions so retrieval is easier and more precise.
3. For feedback/project entries, ensure content is structured as:
   - main rule/fact
   - **Why:**
   - **How to apply:**

## Phase 3 \u2014 Prune
1. Delete memories that are clearly obsolete, contradictory, or low-value.
2. Keep total memory set concise and high signal.

## Guardrails
- Do NOT invent facts.
- If confidence is low, keep existing memory instead of guessing.
- If memory quality is already strong, make no changes and explicitly say so.

Return a short summary of what you updated, merged, or removed.`;
var AUTODREAM_USER_MESSAGE = "Run the consolidation pass over the current memory directory now.";

// node_modules/opencode-claude-memory/dist/sdk.js
function unwrapData(response) {
  if (!response || typeof response !== "object")
    return response;
  if ("data" in response)
    return response.data;
  return response;
}

// node_modules/opencode-claude-memory/dist/util/timeout.js
class TimeoutError extends Error {
  constructor(what, timeoutMs) {
    super(`${what} timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}
function withTimeout(promise, timeoutMs, error) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(error()), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer)
      clearTimeout(timer);
  });
}
function withDeadline(what, timeoutMs, call) {
  const controller = new AbortController;
  let invoked;
  try {
    invoked = Promise.resolve(call(controller.signal));
  } catch (error) {
    return Promise.reject(error);
  }
  return withTimeout(invoked, timeoutMs, () => {
    controller.abort();
    return new TimeoutError(what, timeoutMs);
  });
}

// node_modules/opencode-claude-memory/dist/extraction/forkSession.js
var FORK_CREATE_TIMEOUT_MS = 30000;
var FORK_CLEANUP_TIMEOUT_MS = 15000;

class ForkSessionTimeoutError extends Error {
  constructor(title, timeoutMs) {
    super(`${title} timed out after ${timeoutMs}ms`);
    this.name = "ForkSessionTimeoutError";
  }
}
function extractSessionID(response) {
  const data = unwrapData(response);
  if (!data || typeof data !== "object")
    return;
  const id = data.id ?? data.sessionID;
  return typeof id === "string" ? id : undefined;
}
function describeError(error) {
  if (error && typeof error === "object") {
    const named = error;
    const message = named.data?.message ?? named.message;
    if (typeof message === "string") {
      return typeof named.name === "string" ? `${named.name}: ${message}` : message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}
function forkFailure(response) {
  if (!response || typeof response !== "object")
    return;
  const transport = response.error;
  if (transport !== undefined && transport !== null)
    return describeError(transport);
  const data = unwrapData(response);
  const modelError = data && typeof data === "object" ? data.info?.error : undefined;
  if (modelError !== undefined && modelError !== null)
    return describeError(modelError);
  return;
}

class ForkSessionError extends Error {
  constructor(title, detail) {
    super(`${title}: ${detail}`);
    this.name = "ForkSessionError";
  }
}
async function runForkSession(input) {
  const { client, directory } = input;
  const createTimeoutMs = input.createTimeoutMs ?? FORK_CREATE_TIMEOUT_MS;
  const cleanupTimeoutMs = input.cleanupTimeoutMs ?? FORK_CLEANUP_TIMEOUT_MS;
  const created = await withDeadline(`${input.title} session.create`, createTimeoutMs, (signal) => client.session.create({
    body: { parentID: input.parentSessionID, title: input.title },
    query: { directory },
    signal
  }));
  const createFailure = forkFailure(created);
  if (createFailure)
    throw new ForkSessionError(input.title, `session.create failed (${createFailure})`);
  const forkID = extractSessionID(created);
  if (!forkID)
    throw new ForkSessionError(input.title, "session.create returned no session id");
  input.onCreated?.(forkID);
  const body = {
    agent: input.agent,
    parts: input.parts
  };
  if (input.system !== undefined)
    body.system = input.system;
  if (input.tools !== undefined)
    body.tools = input.tools;
  if (input.format !== undefined)
    body.format = input.format;
  if (input.model !== undefined)
    body.model = input.model;
  const cleanup = async (stage) => {
    try {
      await withDeadline(`${input.title} session.${stage}`, cleanupTimeoutMs, (signal) => stage === "abort" ? client.session.abort({ path: { id: forkID }, query: { directory }, signal }) : client.session.delete({ path: { id: forkID }, query: { directory }, signal }));
    } catch (error) {
      input.onCleanupFailed?.(forkID, stage, error);
    }
  };
  let timedOut = false;
  try {
    let response;
    try {
      response = await withDeadline(`${input.title} session.prompt`, input.timeoutMs, (signal) => client.session.prompt({ path: { id: forkID }, query: { directory }, body, signal }));
    } catch (error) {
      if (error instanceof TimeoutError) {
        timedOut = true;
        throw new ForkSessionTimeoutError(input.title, input.timeoutMs);
      }
      throw error;
    }
    const failure = forkFailure(response);
    if (failure)
      throw new ForkSessionError(input.title, failure);
    return response;
  } finally {
    try {
      if (timedOut)
        await cleanup("abort");
      await cleanup("delete");
    } finally {
      input.onFinished?.(forkID);
    }
  }
}

// node_modules/opencode-claude-memory/dist/store/scan.js
import { readdirSync, readFileSync as readFileSync2, statSync as statSync2 } from "fs";
import { basename, join as join2, sep as sep2 } from "path";

// node_modules/opencode-claude-memory/dist/store/frontmatter.js
var MEMORY_TYPES = ["user", "feedback", "project", "reference"];
var FRONTMATTER_MAX_LINES = 30;
function parseFields(lines) {
  const frontmatter = {};
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1)
      continue;
    const key = line.slice(0, colonIdx).trim();
    const value = unquoteScalar(line.slice(colonIdx + 1).trim());
    if (key && value)
      frontmatter[key] = value;
  }
  return frontmatter;
}
function unquoteScalar(raw) {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const value = JSON.parse(raw);
      if (typeof value === "string")
        return value;
    } catch {
      return raw;
    }
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'"))
    return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}
function quoteScalar(value) {
  const needsQuoting = value === "" || /^-?\d+(\.\d+)?$/.test(value) || /^(true|false|null|~)$/.test(value) || /^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(value) || /[:#]\s|\s#|:$/.test(value) || value.includes(`
`) || value !== value.trim();
  return needsQuoting ? JSON.stringify(value) : value;
}
function findClosingLine(lines) {
  const limit = Math.min(lines.length, FRONTMATTER_MAX_LINES);
  for (let i = 1;i < limit; i++) {
    if (lines[i]?.trimEnd() === "---")
      return i;
  }
  return -1;
}
function parseFrontmatter(raw) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, body: trimmed, hasFrontmatter: false };
  }
  const lines = trimmed.split(`
`);
  const closing = findClosingLine(lines);
  if (closing === -1) {
    return { frontmatter: {}, body: trimmed, hasFrontmatter: false };
  }
  return {
    frontmatter: parseFields(lines.slice(1, closing)),
    body: lines.slice(closing + 1).join(`
`).trim(),
    hasFrontmatter: true
  };
}
function frontmatterKeys(raw) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("---"))
    return;
  const lines = trimmed.split(`
`);
  const closing = findClosingLine(lines);
  if (closing === -1)
    return;
  return lines.slice(1, closing).filter((line) => line.trim() !== "").map((line) => {
    const colonIdx = line.indexOf(":");
    return colonIdx === -1 ? "" : line.slice(0, colonIdx).trim();
  });
}
function parseFrontmatterHeader(raw) {
  const head = raw.trimStart().split(`
`).slice(0, FRONTMATTER_MAX_LINES).join(`
`);
  const { frontmatter, hasFrontmatter } = parseFrontmatter(head);
  return { frontmatter, hasFrontmatter };
}
var ORIGIN = "opencode";
function buildFrontmatter(input) {
  return [
    "---",
    `name: ${quoteScalar(input.name)}`,
    `description: ${quoteScalar(input.description)}`,
    "metadata:",
    `  type: ${input.type}`,
    `  origin: ${ORIGIN}`,
    `  modified: ${input.modified}`,
    "---"
  ].join(`
`);
}
var FENCED_BLOCK = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/;
function indentOf(line) {
  return line.length - line.trimStart().length;
}
function isKeyLine(line, key) {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith(`${key}:`))
    return false;
  const next = trimmed[key.length + 1];
  return next === undefined || /\s/.test(next);
}
function endOfEntry(lines, start) {
  const base = indentOf(lines[start] ?? "");
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end] ?? "";
    if (line.trim() === "") {
      let next = end + 1;
      while (next < lines.length && (lines[next] ?? "").trim() === "")
        next++;
      if (next < lines.length && indentOf(lines[next] ?? "") > base) {
        end = next;
        continue;
      }
      break;
    }
    if (indentOf(line) <= base)
      break;
    end++;
  }
  return end;
}
function findTopLevel(lines, key) {
  return lines.findIndex((line) => indentOf(line) === 0 && isKeyLine(line, key));
}
function setTopLevel(lines, key, value) {
  const at = findTopLevel(lines, key);
  const rendered = `${key}: ${quoteScalar(value)}`;
  if (at === -1)
    lines.push(rendered);
  else
    lines.splice(at, endOfEntry(lines, at) - at, rendered);
}
function metadataBlock(lines) {
  const at = findTopLevel(lines, "metadata");
  if (at === -1)
    return;
  const inline = (lines[at] ?? "").trimStart().slice("metadata:".length).trim();
  return inline === "" || inline.startsWith("#") ? at : undefined;
}
function metadataChildIndent(lines, at) {
  const children = lines.slice(at + 1, endOfEntry(lines, at)).filter((line) => line.trim() !== "");
  return children.length > 0 ? " ".repeat(Math.min(...children.map(indentOf))) : "  ";
}
function findMetadataChild(lines, at, key) {
  const indent = metadataChildIndent(lines, at).length;
  const end = endOfEntry(lines, at);
  for (let i = at + 1;i < end; i++) {
    if (indentOf(lines[i] ?? "") === indent && isKeyLine(lines[i] ?? "", key))
      return i;
  }
  return -1;
}
function setMetadataKey(lines, key, value) {
  let at = metadataBlock(lines);
  if (at === undefined) {
    const existing = findTopLevel(lines, "metadata");
    if (existing === -1) {
      lines.push("metadata:");
      at = lines.length - 1;
    } else if (/^metadata:\s*\{\s*\}\s*$/.test((lines[existing] ?? "").trim())) {
      lines[existing] = "metadata:";
      at = existing;
    } else {
      return false;
    }
  }
  const rendered = `${metadataChildIndent(lines, at)}${key}: ${quoteScalar(value)}`;
  const hit = findMetadataChild(lines, at, key);
  if (hit === -1)
    lines.splice(endOfEntry(lines, at), 0, rendered);
  else
    lines.splice(hit, endOfEntry(lines, hit) - hit, rendered);
  return true;
}
function editFrontmatter(content, edits) {
  const leading = content.length - content.trimStart().length;
  const text = content.slice(leading);
  const match = FENCED_BLOCK.exec(text);
  const lines = match ? (match[1] ?? "").split(/\r?\n/) : [];
  const newline = match?.[0].includes(`\r
`) ? `\r
` : `
`;
  for (const [key, value] of Object.entries(edits.set ?? {}))
    setTopLevel(lines, key, value);
  for (const [key, value] of Object.entries(edits.setWhereExists ?? {})) {
    const atTop = findTopLevel(lines, key) !== -1;
    const meta = metadataBlock(lines);
    const atMeta = meta !== undefined && findMetadataChild(lines, meta, key) !== -1;
    if (atTop)
      setTopLevel(lines, key, value);
    if (atMeta)
      setMetadataKey(lines, key, value);
    if (!atTop && !atMeta && !setMetadataKey(lines, key, value))
      setTopLevel(lines, key, value);
  }
  for (const [key, value] of Object.entries(edits.setMeta ?? {}))
    setMetadataKey(lines, key, value);
  const head = ["---", ...lines, "---"].join(newline);
  const original = match ? text.slice(match[0].length) : text;
  if (edits.body === undefined)
    return `${head}${newline}${original}`;
  const gap = !match || /^\r?\n/.test(original) ? newline : "";
  return `${head}${newline}${gap}${edits.body.trim().replace(/\r?\n/g, newline)}${newline}`;
}
function parseMemoryType(raw) {
  if (!raw)
    return;
  return MEMORY_TYPES.find((t) => t === raw);
}

// node_modules/opencode-claude-memory/dist/store/paths.js
import { lstatSync, readFileSync, realpathSync, statSync } from "fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "path";
var ENTRYPOINT_NAME = "MEMORY.md";
var MAX_ENTRYPOINT_LINES = 200;
var MAX_ENTRYPOINT_BYTES = 25000;
var MAX_MEMORY_FILES = 200;
var MAX_MEMORY_FILE_BYTES = 40000;
var MAX_SANITIZED_LENGTH = 200;
function validateMemoryFileName(fileName) {
  if (typeof fileName !== "string" || fileName.length === 0) {
    throw new Error("Memory file name cannot be empty");
  }
  if (fileName.includes("\x00")) {
    throw new Error(`Memory file name must not contain null bytes: ${fileName}`);
  }
  if (isAbsolute(fileName) || /^[A-Za-z]:/.test(fileName) || /^[\\/]/.test(fileName)) {
    throw new Error(`Memory file name must be relative to the memory directory: ${fileName}`);
  }
  const segments = fileName.split(/[\\/]/);
  const last = segments.length - 1;
  for (let i = 0;i < segments.length; i++) {
    let segment = segments[i] ?? "";
    if (i === last && segment.endsWith(".md"))
      segment = segment.slice(0, -3);
    if (segment.length === 0) {
      throw new Error(`Memory file name must not contain empty path segments: ${fileName}`);
    }
    if (segment === "." || segment.includes("..")) {
      throw new Error(`Memory file name must not contain path traversal: ${fileName}`);
    }
    if (segment.startsWith(".")) {
      throw new Error(`Memory file name segments must not start with '.': ${fileName}`);
    }
    segments[i] = segment;
  }
  if ((segments[last] ?? "").toUpperCase() === "MEMORY") {
    throw new Error("'MEMORY' is a reserved name and cannot be used as a memory file name");
  }
  return `${segments.join("/")}.md`;
}
function canonical(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return;
  }
}
function existsNoFollow(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
function isInside(path, root) {
  return path === root || path.startsWith(root + sep);
}
function resolveMemoryFilePath(memoryDir, fileName) {
  const relativePath = validateMemoryFileName(fileName);
  const root = resolve(memoryDir);
  const filePath = resolve(root, ...relativePath.split("/"));
  if (!filePath.startsWith(root + sep)) {
    throw new Error(`Memory file name resolves outside the memory directory: ${fileName}`);
  }
  const realRoot = canonical(root);
  if (realRoot !== undefined) {
    let probe = filePath;
    while (probe !== root && !existsNoFollow(probe))
      probe = dirname(probe);
    const realProbe = canonical(probe);
    if (realProbe === undefined || !isInside(realProbe, realRoot)) {
      throw new Error(`Memory file name resolves outside the memory directory: ${fileName}`);
    }
  }
  return { relativePath, filePath };
}
function djb2Hash(str) {
  let hash = 0;
  for (let i = 0;i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i) | 0;
  }
  return hash;
}
function simpleHash(str) {
  return Math.abs(djb2Hash(str)).toString(36);
}
function sanitizePath(name) {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return sanitized;
  }
  const hash = simpleHash(name);
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${hash}`;
}
function findGitRoot(startPath) {
  let current = resolve(startPath);
  const root = current.substring(0, current.indexOf(sep) + 1) || sep;
  while (current !== root) {
    try {
      const gitPath = join(current, ".git");
      const s = statSync(gitPath);
      if (s.isDirectory() || s.isFile()) {
        return current.normalize("NFC");
      }
    } catch {}
    const parent = dirname(current);
    if (parent === current)
      break;
    current = parent;
  }
  try {
    const gitPath = join(root, ".git");
    const s = statSync(gitPath);
    if (s.isDirectory() || s.isFile()) {
      return root.normalize("NFC");
    }
  } catch {}
  return null;
}
function resolveCanonicalRoot(gitRoot) {
  try {
    const gitContent = readFileSync(join(gitRoot, ".git"), "utf-8").trim();
    if (!gitContent.startsWith("gitdir:")) {
      return gitRoot;
    }
    const worktreeGitDir = resolve(gitRoot, gitContent.slice("gitdir:".length).trim());
    const commonDir = resolve(worktreeGitDir, readFileSync(join(worktreeGitDir, "commondir"), "utf-8").trim());
    if (resolve(dirname(worktreeGitDir)) !== join(commonDir, "worktrees")) {
      return gitRoot;
    }
    const backlink = realpathSync(readFileSync(join(worktreeGitDir, "gitdir"), "utf-8").trim());
    if (backlink !== join(realpathSync(gitRoot), ".git")) {
      return gitRoot;
    }
    if (commonDir.endsWith(`${sep}.git`) || commonDir.endsWith("/.git")) {
      return dirname(commonDir).normalize("NFC");
    }
    return commonDir.normalize("NFC");
  } catch {
    return gitRoot;
  }
}
function findCanonicalGitRoot(startPath) {
  const root = findGitRoot(startPath);
  if (!root)
    return null;
  return resolveCanonicalRoot(root);
}
function isRootPath(path) {
  const resolved = resolve(path);
  return resolved === parse(resolved).root;
}
function resolveMemoryRoot(worktree, directory) {
  if (isRootPath(worktree) && !isRootPath(directory))
    return directory;
  return worktree;
}

// node_modules/opencode-claude-memory/dist/store/scan.js
function nameFromFilename(filename) {
  return basename(filename).replace(/\.md$/, "");
}
function surfaceKey(header) {
  return `${header.name}|${header.type}`;
}
function headerFrom(filename, filePath, mtimeMs, parsed) {
  return {
    filename,
    filePath,
    mtimeMs,
    name: parsed.frontmatter.name ?? nameFromFilename(filename),
    description: parsed.frontmatter.description ?? "",
    type: parseMemoryType(parsed.frontmatter.type) ?? "user",
    hasFrontmatter: parsed.hasFrontmatter
  };
}
function readMemoryHeader(memoryDir, filename) {
  const filePath = join2(memoryDir, ...filename.split("/"));
  try {
    const raw = readFileSync2(filePath, "utf-8");
    const mtimeMs = statSync2(filePath).mtimeMs;
    return headerFrom(filename, filePath, mtimeMs, parseFrontmatterHeader(raw));
  } catch {
    return null;
  }
}
function readMemoryEntry(memoryDir, filename) {
  const filePath = join2(memoryDir, ...filename.split("/"));
  try {
    const raw = readFileSync2(filePath, "utf-8");
    const mtimeMs = statSync2(filePath).mtimeMs;
    const parsed = parseFrontmatter(raw);
    return { ...headerFrom(filename, filePath, mtimeMs, parsed), body: parsed.body, raw };
  } catch {
    return null;
  }
}
function readMemoryBody(filePath) {
  try {
    return parseFrontmatter(readFileSync2(filePath, "utf-8")).body;
  } catch {
    return "";
  }
}
function listMarkdownFiles(memoryDir, recursive) {
  const out = [];
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = String(entry.name);
      const relative = prefix ? `${prefix}/${name}` : name;
      if (entry.isSymbolicLink())
        continue;
      if (entry.isDirectory()) {
        if (recursive)
          walk(join2(dir, name), relative);
      } else if (entry.isFile() && name.endsWith(".md") && name !== ENTRYPOINT_NAME) {
        out.push(relative);
      }
    }
  };
  walk(memoryDir, "");
  return out;
}
function scanMemoryFiles(memoryDir, options = {}) {
  const headers = [];
  for (const entry of listMarkdownFiles(memoryDir, options.recursive ?? true)) {
    const header = readMemoryHeader(memoryDir, entry);
    if (header)
      headers.push(header);
  }
  return headers.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_MEMORY_FILES);
}
function formatMemoryManifest(memories) {
  return memories.map((m) => {
    const ts = new Date(m.mtimeMs).toISOString();
    return m.description ? `- [${m.type}] ${m.filename} (${ts}): ${m.description}` : `- [${m.type}] ${m.filename} (${ts})`;
  }).join(`
`);
}

// node_modules/opencode-claude-memory/dist/recall/selector.js
var SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to OpenCode as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a list of filenames for the memories that will clearly be useful to OpenCode as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- If a list of recently-used tools is provided, do not select memories that are usage reference or API documentation for those tools (OpenCode is already exercising them). DO still select memories containing warnings, gotchas, or known issues about those tools \u2014 active use is exactly when those matter.
`;
var SELECT_MEMORIES_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      selected_memories: { type: "array", items: { type: "string" } }
    },
    required: ["selected_memories"],
    additionalProperties: false
  }
};
var RECALL_SELECTOR_TITLE = "opencode-memory recall selector";
function tryParseSelectedMemories(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.selected_memories))
      return;
    return parsed.selected_memories.filter((item) => typeof item === "string");
  } catch {
    return;
  }
}
function extractSelectedMemories(response) {
  const data = unwrapData(response);
  if (!data || typeof data !== "object")
    return [];
  const structured = data.info?.structured;
  if (structured && typeof structured === "object") {
    const selected = structured.selected_memories;
    if (Array.isArray(selected)) {
      return selected.filter((item) => typeof item === "string");
    }
  }
  if (!Array.isArray(data.parts))
    return [];
  for (const part of data.parts) {
    if (!part || typeof part !== "object")
      continue;
    const text = part.text;
    if (typeof text !== "string")
      continue;
    const parsed = tryParseSelectedMemories(text);
    if (parsed)
      return parsed;
  }
  return [];
}
function buildSelectorQuery(query, memories, recentTools) {
  const toolsSection = recentTools.length > 0 ? `

Recently used tools: ${recentTools.join(", ")}` : "";
  return `Query: ${query}

Available memories:
${formatMemoryManifest(memories)}${toolsSection}`;
}
async function selectRelevantMemoryFilenames(input) {
  if (input.memories.length === 0)
    return [];
  try {
    const response = await runForkSession({
      client: input.client,
      directory: input.directory,
      parentSessionID: input.parentSessionID,
      title: RECALL_SELECTOR_TITLE,
      agent: input.agent,
      system: SELECT_MEMORIES_SYSTEM_PROMPT,
      tools: input.tools ?? { "*": false },
      format: SELECT_MEMORIES_FORMAT,
      parts: [{ type: "text", text: buildSelectorQuery(input.query, input.memories, input.recentTools) }],
      timeoutMs: input.timeoutMs,
      onCreated: input.onSessionCreated,
      onFinished: input.onSessionFinished
    });
    const validFilenames = new Set(input.memories.map((memory) => memory.filename));
    return extractSelectedMemories(response).filter((filename) => validFilenames.has(filename)).slice(0, input.maxMemories);
  } catch {
    return [];
  }
}

// node_modules/opencode-claude-memory/dist/agents.js
var MEMORY_TOOL_NAMES = [
  "memory_save",
  "memory_delete",
  "memory_list",
  "memory_search",
  "memory_read"
];
var ALL_MEMORY_TOOLS = Object.fromEntries(MEMORY_TOOL_NAMES.map((name) => [name, true]));
function buildAgentDefaults(agents) {
  return {
    [agents.recall]: {
      mode: "all",
      hidden: true,
      temperature: 0,
      prompt: SELECT_MEMORIES_SYSTEM_PROMPT,
      tools: { "*": false }
    },
    [agents.extract]: {
      mode: "all",
      hidden: true,
      prompt: EXTRACT_PROMPT,
      steps: 30,
      tools: { "*": false, memory_save: true, memory_list: true, memory_read: true }
    },
    [agents.dream]: {
      mode: "all",
      hidden: true,
      prompt: AUTODREAM_PROMPT,
      steps: 60,
      tools: { "*": false, ...ALL_MEMORY_TOOLS }
    }
  };
}
function mergeAgentConfig(defaults, user) {
  if (!user)
    return { ...defaults };
  const merged = { ...defaults, ...user };
  if (user.steps === undefined && user.maxSteps !== undefined)
    delete merged.steps;
  return merged;
}

class AgentRegistry {
  defaults;
  merged;
  constructor(agents) {
    this.defaults = buildAgentDefaults(agents);
    this.merged = { ...this.defaults };
  }
  register(config) {
    config.agent ??= {};
    const agent = config.agent;
    for (const [name, defaults] of Object.entries(this.defaults)) {
      const merged = mergeAgentConfig(defaults, agent[name]);
      agent[name] = merged;
      this.merged[name] = merged;
    }
  }
  toolsFor(name) {
    return this.merged[name]?.tools;
  }
}

// node_modules/opencode-claude-memory/dist/config.js
import { homedir } from "os";
import { join as join3 } from "path";

// node_modules/opencode-claude-memory/node_modules/zod/v3/helpers/util.js
var util;
(function(util) {
  util.assertEqual = (_) => {};
  function assertIs(_arg) {}
  util.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error;
  }
  util.assertNever = assertNever;
  util.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util.getValidEnumValues = (obj) => {
    const validKeys = util.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util.objectValues(filtered);
  };
  util.objectValues = (obj) => {
    return util.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key in object) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return;
  };
  util.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util.joinValues = joinValues;
  util.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil) {
  objectUtil.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};

// node_modules/opencode-claude-memory/node_modules/zod/v3/ZodError.js
var ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
class ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue) {
      return issue.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues) {
        if (issue.code === "invalid_union") {
          issue.unionErrors.map(processError);
        } else if (issue.code === "invalid_return_type") {
          processError(issue.returnTypeError);
        } else if (issue.code === "invalid_arguments") {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
}
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};

// node_modules/opencode-claude-memory/node_modules/zod/v3/locales/en.js
var errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object") {
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ("startsWith" in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ("endsWith" in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== "regex") {
        message = `Invalid ${issue.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "bigint")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
var en_default = errorMap;

// node_modules/opencode-claude-memory/node_modules/zod/v3/errors.js
var overrideErrorMap = en_default;
function getErrorMap() {
  return overrideErrorMap;
}

// node_modules/opencode-claude-memory/node_modules/zod/v3/helpers/parseUtil.js
var makeIssue = (params) => {
  const { data, path, errorMaps, issueData } = params;
  const fullPath = [...path, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== undefined) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map of maps) {
    errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      ctx.schemaErrorMap,
      overrideMap,
      overrideMap === en_default ? undefined : en_default
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}

class ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
}
var INVALID = Object.freeze({
  status: "aborted"
});
var DIRTY = (value) => ({ status: "dirty", value });
var OK = (value) => ({ status: "valid", value });
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;

// node_modules/opencode-claude-memory/node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function(errorUtil) {
  errorUtil.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));

// node_modules/opencode-claude-memory/node_modules/zod/v3/types.js
class ParseInputLazyPath {
  constructor(parent, value, path, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
}
var handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap, invalid_type_error, required_error, description } = params;
  if (errorMap && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap)
    return { errorMap, description };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}

class ZodType {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus,
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: params?.async ?? false,
        contextualErrorMap: params?.errorMap
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  "~validate"(data) {
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err) {
        if (err?.message?.toLowerCase()?.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params?.errorMap,
        async: true
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(undefined).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
}
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    if (!header)
      return false;
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && decoded?.typ !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version) {
  if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}

class ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus;
    let ctx = undefined;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      offset: options?.offset ?? false,
      local: options?.local ?? false,
      ...errorUtil.errToObj(options?.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      ...errorUtil.errToObj(options?.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options?.position,
      ...errorUtil.errToObj(options?.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
}
ZodString.create = (params) => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}

class ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx.parsedType
      });
      return INVALID;
    }
    let ctx = undefined;
    const status = new ParseStatus;
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
}
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};

class ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = undefined;
    const status = new ParseStatus;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
}
ZodBigInt.create = (params) => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};

class ZodBoolean extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};

class ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus;
    let ctx = undefined;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
}
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: params?.coerce || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};

class ZodSymbol extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};

class ZodUndefined extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};

class ZodNull extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};

class ZodAny extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
}
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};

class ZodUnknown extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
}
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};

class ZodNever extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
}
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};

class ZodVoid extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};

class ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : undefined,
          maximum: tooBig ? def.exactLength.value : undefined,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result) => {
        return ParseStatus.mergeArray(status, result);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
}
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}

class ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: { status: "valid", value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key },
            value: { status: "valid", value: ctx.data[key] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") {} else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: catchall._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== undefined ? {
        errorMap: (issue, ctx) => {
          const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: errorUtil.errToObj(message).message ?? defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  extend(augmentation) {
    return new ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  merge(merging) {
    const merged = new ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  catchall(index) {
    return new ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    for (const key of util.objectKeys(mask)) {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
}
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};

class ZodUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = undefined;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues) => new ZodError(issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
}
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
var getDiscriminator = (type) => {
  if (type instanceof ZodLazy) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral) {
    return [type.value];
  } else if (type instanceof ZodEnum) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined) {
    return [undefined];
  } else if (type instanceof ZodNull) {
    return [null];
  } else if (type instanceof ZodOptional) {
    return [undefined, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodNullable) {
    return [null, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
};

class ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  static create(discriminator, options, params) {
    const optionsMap = new Map;
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type);
      }
    }
    return new ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params)
    });
  }
}
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0;index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}

class ZodIntersection extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
}
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};

class ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new ZodTuple({
      ...this._def,
      rest
    });
  }
}
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};

class ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
}

class ZodMap extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = new Map;
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = new Map;
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
}
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};

class ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements) {
      const parsedSet = new Set;
      for (const element of elements) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements) => finalizeSet(elements));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
}
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};

class ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args, error) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error
        }
      });
    }
    function makeReturnsIssue(returns, error) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error
        }
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function(...args) {
        const error = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
          error.addIssue(makeArgsIssue(args, e));
          throw error;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
          error.addIssue(makeReturnsIssue(result, e));
          throw error;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function(...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) {
          throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success) {
          throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create())
    });
  }
  returns(returnType) {
    return new ZodFunction({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params) {
    return new ZodFunction({
      args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params)
    });
  }
}

class ZodLazy extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
}
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};

class ZodLiteral extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
}
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}

class ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
}
ZodEnum.create = createZodEnum;

class ZodNativeEnum extends ZodType {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
}
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};

class ZodPromise extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
}
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};

class ZodEffects extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed) => {
          if (status.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base))
          return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
          if (!isValid(base))
            return INVALID;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
            status: status.value,
            value: result
          }));
        });
      }
    }
    util.assertNever(effect);
  }
}
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
class ZodOptional extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(undefined);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
}
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};

class ZodNullable extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
}
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};

class ZodDefault extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
}
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};

class ZodCatch extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result) => {
        return {
          status: "valid",
          value: result.status === "valid" ? result.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
}
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};

class ZodNaN extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
}
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
var BRAND = Symbol("zod_brand");

class ZodBranded extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
}

class ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
}

class ZodReadonly extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
}
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
var late = {
  object: ZodObject.lazycreate
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind) {
  ZodFirstPartyTypeKind["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var stringType = ZodString.create;
var numberType = ZodNumber.create;
var nanType = ZodNaN.create;
var bigIntType = ZodBigInt.create;
var booleanType = ZodBoolean.create;
var dateType = ZodDate.create;
var symbolType = ZodSymbol.create;
var undefinedType = ZodUndefined.create;
var nullType = ZodNull.create;
var anyType = ZodAny.create;
var unknownType = ZodUnknown.create;
var neverType = ZodNever.create;
var voidType = ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
var strictObjectType = ZodObject.strictCreate;
var unionType = ZodUnion.create;
var discriminatedUnionType = ZodDiscriminatedUnion.create;
var intersectionType = ZodIntersection.create;
var tupleType = ZodTuple.create;
var recordType = ZodRecord.create;
var mapType = ZodMap.create;
var setType = ZodSet.create;
var functionType = ZodFunction.create;
var lazyType = ZodLazy.create;
var literalType = ZodLiteral.create;
var enumType = ZodEnum.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional.create;
var nullableType = ZodNullable.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;
// node_modules/opencode-claude-memory/dist/config.js
var MAX_TIMER_DELAY_MS = 2147483647;
var timeoutMs = (fallback) => numberType().int().positive().max(MAX_TIMER_DELAY_MS).default(fallback);
var MemoryOptionsSchema = objectType({
  extract: objectType({
    enabled: booleanType().default(true),
    timeoutMs: timeoutMs(120000),
    debounceMs: numberType().int().nonnegative().max(MAX_TIMER_DELAY_MS).default(1e4),
    maxConversationChars: numberType().int().positive().default(60000),
    catchUpLimit: numberType().int().nonnegative().default(5)
  }).strict().default({}),
  autodream: objectType({
    enabled: booleanType().default(true),
    minHours: numberType().positive().default(24),
    minSessions: numberType().int().positive().default(5),
    timeoutMs: timeoutMs(300000)
  }).strict().default({}),
  recall: objectType({
    enabled: booleanType().default(true),
    waitMs: numberType().int().nonnegative().max(MAX_TIMER_DELAY_MS).default(1500),
    timeoutMs: timeoutMs(30000),
    maxMemories: numberType().int().positive().max(20).default(5)
  }).strict().default({})
}).strict();
var MEMORY_AGENTS = {
  extract: "opencode-memory-extract",
  recall: "opencode-memory-recall",
  dream: "opencode-memory-dream"
};

class MemoryConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "MemoryConfigError";
  }
}
function formatIssue(issue) {
  const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
  return `${path}: ${issue.message}`;
}
function resolveClaudeConfigDir(env = process.env) {
  const raw = env.CLAUDE_CONFIG_DIR?.trim();
  return (raw ? raw : join3(homedir(), ".claude")).normalize("NFC");
}
function parseMemoryOptions(options) {
  const result = MemoryOptionsSchema.safeParse(options ?? {});
  if (!result.success) {
    const issues = result.error.issues.map(formatIssue).join("; ");
    throw new MemoryConfigError(`opencode-claude-memory: invalid plugin options (${issues})`);
  }
  return result.data;
}
function parseConfig(options, env = process.env, homeDir = homedir()) {
  return {
    ...parseMemoryOptions(options),
    claudeConfigDir: resolveClaudeConfigDir(env),
    homeDir,
    agents: MEMORY_AGENTS
  };
}

// node_modules/opencode-claude-memory/dist/store/indexFile.js
import { readFileSync as readFileSync3 } from "fs";
var POINTER_RE = /^\s*[-*]\s+\[(.*?)\]\(([^()\s]+)\)/;
function readIndexFile(entrypoint) {
  try {
    return readFileSync3(entrypoint, "utf-8");
  } catch {
    return "";
  }
}
function buildIndexPointer(fileName, name, description) {
  return `- [${name}](${fileName}) \u2014 ${description}`;
}
function indexHasPointer(raw, pointer) {
  return raw.split(/\r?\n/).some((line) => line.trimEnd() === pointer);
}
function detectEol(raw) {
  return raw.includes(`\r
`) ? `\r
` : `
`;
}
function pointerTarget(line) {
  const match = POINTER_RE.exec(line);
  return match?.[2];
}
function splitIndex(raw) {
  const eol = detectEol(raw);
  const lines = raw.split(/\r?\n/);
  const trailingNewline = raw.endsWith(`
`);
  if (trailingNewline)
    lines.pop();
  return { lines, eol, trailingNewline };
}
function joinIndex(parts) {
  if (parts.lines.length === 0)
    return "";
  return parts.lines.join(parts.eol) + (parts.trailingNewline ? parts.eol : "");
}
function dedupePointers(lines, fileName, keepFirst) {
  let kept = -1;
  for (let i = 0;i < lines.length; i++) {
    if (pointerTarget(lines[i] ?? "") !== fileName)
      continue;
    if (kept === -1 && keepFirst) {
      kept = i;
      continue;
    }
    lines.splice(i, 1);
    i -= 1;
  }
  return kept;
}
function upsertIndexLine(raw, fileName, pointer) {
  if (!raw.trim())
    return `${pointer}
`;
  const parts = splitIndex(raw);
  const { lines } = parts;
  const existingIdx = dedupePointers(lines, fileName, true);
  if (existingIdx >= 0) {
    const indent = /^\s*/.exec(lines[existingIdx] ?? "")?.[0] ?? "";
    lines[existingIdx] = indent + pointer;
    return joinIndex(parts);
  }
  let lastPointerIdx = -1;
  for (let i = lines.length - 1;i >= 0; i--) {
    if (POINTER_RE.test(lines[i] ?? "")) {
      lastPointerIdx = i;
      break;
    }
  }
  if (lastPointerIdx >= 0) {
    lines.splice(lastPointerIdx + 1, 0, pointer);
  } else {
    if (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() !== "")
      lines.push("");
    lines.push(pointer);
  }
  return joinIndex(parts);
}
function removeIndexLine(raw, fileName) {
  if (!raw)
    return raw;
  const parts = splitIndex(raw);
  const { lines } = parts;
  const idx = lines.findIndex((line) => pointerTarget(line) === fileName);
  if (idx === -1)
    return raw;
  dedupePointers(lines, fileName, false);
  const before = idx - 1;
  const after = idx;
  const isBlank = (i) => i >= 0 && i < lines.length && (lines[i] ?? "").trim() === "";
  if (isBlank(before) && (isBlank(after) || after >= lines.length)) {
    lines.splice(before, 1);
  } else if (isBlank(after) && before < 0) {
    lines.splice(after, 1);
  }
  if (lines.every((line) => line.trim() === ""))
    return "";
  return joinIndex(parts);
}
function formatFileSize(bytes) {
  if (bytes < 1024)
    return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}
function truncateEntrypoint(raw) {
  const trimmed = raw.trim();
  if (!trimmed)
    return { content: "", lineCount: 0, byteCount: 0, wasLineTruncated: false, wasByteTruncated: false };
  const contentLines = trimmed.split(`
`);
  const lineCount = contentLines.length;
  const byteCount = trimmed.length;
  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES;
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES;
  if (!wasLineTruncated && !wasByteTruncated) {
    return { content: trimmed, lineCount, byteCount, wasLineTruncated, wasByteTruncated };
  }
  let truncated = wasLineTruncated ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join(`
`) : trimmed;
  if (truncated.length > MAX_ENTRYPOINT_BYTES) {
    const cutAt = truncated.lastIndexOf(`
`, MAX_ENTRYPOINT_BYTES);
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES);
  }
  const reason = wasByteTruncated && !wasLineTruncated ? `${formatFileSize(byteCount)} (limit: ${formatFileSize(MAX_ENTRYPOINT_BYTES)}) \u2014 index entries are too long` : wasLineTruncated && !wasByteTruncated ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})` : `${lineCount} lines and ${formatFileSize(byteCount)}`;
  return {
    content: `${truncated}

> WARNING: ${ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated
  };
}

// node_modules/opencode-claude-memory/dist/prompt/sections.js
var FRONTMATTER_EXAMPLE = [
  "```markdown",
  "---",
  "name: {{memory name}}",
  "description: {{one-line description \u2014 used to decide relevance in future conversations, so be specific}}",
  `type: {{${MEMORY_TYPES.join(", ")}}}`,
  "---",
  "",
  "{{memory content \u2014 for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines}}",
  "```"
];
var TYPES_SECTION = [
  "## Types of memory",
  "",
  "There are several discrete types of memory that you can store in your memory system:",
  "",
  "<types>",
  "<type>",
  "    <name>user</name>",
  "    <description>Contain information about the user's role, goals, responsibilities, and knowledge. Great user memories help you tailor your future behavior to the user's preferences and perspective. Your goal in reading and writing these memories is to build up an understanding of who the user is and how you can be most helpful to them specifically. For example, you should collaborate with a senior software engineer differently than a student who is coding for the very first time. Keep in mind, that the aim here is to be helpful to the user. Avoid writing memories about the user that could be viewed as a negative judgement or that are not relevant to the work you're trying to accomplish together.</description>",
  "    <when_to_save>When you learn any details about the user's role, preferences, responsibilities, or knowledge</when_to_save>",
  "    <how_to_use>When your work should be informed by the user's profile or perspective. For example, if the user is asking you to explain a part of the code, you should answer that question in a way that is tailored to the specific details that they will find most valuable or that helps them build their mental model in relation to domain knowledge they already have.</how_to_use>",
  "    <examples>",
  "    user: I'm a data scientist investigating what logging we have in place",
  "    assistant: [saves user memory: user is a data scientist, currently focused on observability/logging]",
  "",
  "    user: I've been writing Go for ten years but this is my first time touching the React side of this repo",
  "    assistant: [saves user memory: deep Go expertise, new to React and this project's frontend \u2014 frame frontend explanations in terms of backend analogues]",
  "    </examples>",
  "</type>",
  "<type>",
  "    <name>feedback</name>",
  "    <description>Guidance the user has given you about how to approach work \u2014 both what to avoid and what to keep doing. These are a very important type of memory to read and write as they allow you to remain coherent and responsive to the way you should approach work in the project. Record from failure AND success: if you only save corrections, you will avoid past mistakes but drift away from approaches the user has already validated, and may grow overly cautious.</description>",
  `    <when_to_save>Any time the user corrects your approach ("no not that", "don't", "stop doing X") OR confirms a non-obvious approach worked ("yes exactly", "perfect, keep doing that", accepting an unusual choice without pushback). Corrections are easy to notice; confirmations are quieter \u2014 watch for them. In both cases, save what is applicable to future conversations, especially if surprising or not obvious from the code. Include *why* so you can judge edge cases later.</when_to_save>`,
  "    <how_to_use>Let these memories guide your behavior so that the user does not need to offer the same guidance twice.</how_to_use>",
  "    <body_structure>Lead with the rule itself, then a **Why:** line (the reason the user gave \u2014 often a past incident or strong preference) and a **How to apply:** line (when/where this guidance kicks in). Knowing *why* lets you judge edge cases instead of blindly following the rule.</body_structure>",
  "    <examples>",
  "    user: don't mock the database in these tests \u2014 we got burned last quarter when mocked tests passed but the prod migration failed",
  "    assistant: [saves feedback memory: integration tests must hit a real database, not mocks. Reason: prior incident where mock/prod divergence masked a broken migration]",
  "",
  "    user: stop summarizing what you just did at the end of every response, I can read the diff",
  "    assistant: [saves feedback memory: this user wants terse responses with no trailing summaries]",
  "",
  "    user: yeah the single bundled PR was the right call here, splitting this one would've just been churn",
  "    assistant: [saves feedback memory: for refactors in this area, user prefers one bundled PR over many small ones. Confirmed after I chose this approach \u2014 a validated judgment call, not a correction]",
  "    </examples>",
  "</type>",
  "<type>",
  "    <name>project</name>",
  "    <description>Information that you learn about ongoing work, goals, initiatives, bugs, or incidents within the project that is not otherwise derivable from the code or git history. Project memories help you understand the broader context and motivation behind the work the user is doing within this working directory.</description>",
  '    <when_to_save>When you learn who is doing what, why, or by when. These states change relatively quickly so try to keep your understanding of this up to date. Always convert relative dates in user messages to absolute dates when saving (e.g., "Thursday" \u2192 "2026-03-05"), so the memory remains interpretable after time passes.</when_to_save>',
  "    <how_to_use>Use these memories to more fully understand the details and nuance behind the user's request and make better informed suggestions.</how_to_use>",
  "    <body_structure>Lead with the fact or decision, then a **Why:** line (the motivation \u2014 often a constraint, deadline, or stakeholder ask) and a **How to apply:** line (how this should shape your suggestions). Project memories decay fast, so the why helps future-you judge whether the memory is still load-bearing.</body_structure>",
  "    <examples>",
  "    user: we're freezing all non-critical merges after Thursday \u2014 mobile team is cutting a release branch",
  "    assistant: [saves project memory: merge freeze begins 2026-03-05 for mobile release cut. Flag any non-critical PR work scheduled after that date]",
  "",
  "    user: the reason we're ripping out the old auth middleware is that legal flagged it for storing session tokens in a way that doesn't meet the new compliance requirements",
  "    assistant: [saves project memory: auth middleware rewrite is driven by legal/compliance requirements around session token storage, not tech-debt cleanup \u2014 scope decisions should favor compliance over ergonomics]",
  "    </examples>",
  "</type>",
  "<type>",
  "    <name>reference</name>",
  "    <description>Stores pointers to where information can be found in external systems. These memories allow you to remember where to look to find up-to-date information outside of the project directory.</description>",
  "    <when_to_save>When you learn about resources in external systems and their purpose. For example, that bugs are tracked in a specific project in Linear or that feedback can be found in a specific Slack channel.</when_to_save>",
  "    <how_to_use>When the user references an external system or information that may be in an external system.</how_to_use>",
  "    <examples>",
  `    user: check the Linear project "INGEST" if you want context on these tickets, that's where we track all pipeline bugs`,
  `    assistant: [saves reference memory: pipeline bugs are tracked in Linear project "INGEST"]`,
  "",
  "    user: the Grafana board at grafana.internal/d/api-latency is what oncall watches \u2014 if you're touching request handling, that's the thing that'll page someone",
  "    assistant: [saves reference memory: grafana.internal/d/api-latency is the oncall latency dashboard \u2014 check it when editing request-path code]",
  "    </examples>",
  "</type>",
  "</types>",
  ""
].join(`
`);
var WHAT_NOT_TO_SAVE = [
  "## What NOT to save in memory",
  "",
  "- Code patterns, conventions, architecture, file paths, or project structure \u2014 these can be derived by reading the current project state.",
  "- Git history, recent changes, or who-changed-what \u2014 `git log` / `git blame` are authoritative.",
  "- Debugging solutions or fix recipes \u2014 the fix is in the code; the commit message has the context.",
  "- Anything already documented in AGENTS.md or project config files.",
  "- Ephemeral task details: in-progress work, temporary state, current conversation context.",
  "",
  "These exclusions apply even when the user explicitly asks you to save. If they ask you to save a PR list or activity summary, ask what was *surprising* or *non-obvious* about it \u2014 that is the part worth keeping."
].join(`
`);
var WHEN_TO_ACCESS = [
  "## When to access memories",
  "- When memories seem relevant, or the user references prior-conversation work.",
  "- You MUST access memory when the user explicitly asks you to check, recall, or remember.",
  "- If the user says to *ignore* or *not use* memory: proceed as if MEMORY.md were empty. Do not apply remembered facts, cite, compare against, or mention memory content.",
  "- Memory records can become stale over time. Use memory as context for what was true at a given point in time. Before answering the user or building assumptions based solely on information in memory records, verify that the memory is still correct and up-to-date by reading the current state of the files or resources. If a recalled memory conflicts with current information, trust what you observe now \u2014 and update or remove the stale memory rather than acting on it."
].join(`
`);
var TRUSTING_RECALL = [
  "## Before recommending from memory",
  "",
  "A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it:",
  "",
  "- If the memory names a file path: check the file exists.",
  "- If the memory names a function or flag: grep for it.",
  "- If the user is about to act on your recommendation (not just asking about history), verify first.",
  "",
  '"The memory says X exists" is not the same as "X exists now."',
  "",
  "A memory that summarizes repo state (activity logs, architecture snapshots) is frozen in time. If the user asks about *recent* or *current* state, prefer `git log` or reading the code over recalling the snapshot."
].join(`
`);
var PERSISTENCE_SECTION = [
  "## Memory and other forms of persistence",
  "Memory is one of several persistence mechanisms available to you as you assist the user in a given conversation. The distinction is often that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.",
  "- When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task and would like to reach alignment with the user on your approach you should use a Plan rather than saving this information to memory. Similarly, if you already have a plan within the conversation and you have changed your approach persist that change by updating the plan rather than saving a memory.",
  "- When to use or update tasks instead of memory: When you need to break your work in current conversation into discrete steps or keep track of your progress use tasks instead of saving to memory. Tasks are great for persisting information about the work that needs to be done in the current conversation, but memory should be reserved for information that will be useful in future conversations."
].join(`
`);
function buildSearchingPastContextSection(memoryDir, projectDir) {
  const memSearch = `grep -rn "<search term>" ${memoryDir} --include="*.md"`;
  const transcriptSearch = `grep -rn "<search term>" ${projectDir}/ --include="*.jsonl"`;
  return [
    "## Searching past context",
    "",
    "When looking for past context:",
    "1. Search topic files in your memory directory:",
    "```",
    memSearch,
    "```",
    "2. Session transcript logs (last resort \u2014 large files, slow):",
    "```",
    transcriptSearch,
    "```",
    "Use narrow search terms (error messages, file paths, function names) rather than broad keywords.",
    ""
  ];
}

// node_modules/opencode-claude-memory/dist/prompt/systemPrompt.js
var AUTO_MEMORY_MARKER = "<!-- opencode-claude-memory -->";
var RECALLED_MEMORIES_HEADING = "## Recalled Memories";
function buildMemorySystemPrompt(store, recalledMemoriesSection, options = {}) {
  const includeIndex = options.includeIndex ?? true;
  const howToSave = [
    "## How to save memories",
    "",
    "Saving a memory is a two-step process:",
    "",
    "**Step 1** \u2014 write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:",
    "",
    ...FRONTMATTER_EXAMPLE,
    "",
    `**Step 2** \u2014 add a pointer to that file in \`${ENTRYPOINT_NAME}\`. \`${ENTRYPOINT_NAME}\` is an index, not a memory \u2014 each entry should be one line, under ~150 characters: \`- [Title](file.md) \u2014 one-line hook\`. It has no frontmatter. Never write memory content directly into \`${ENTRYPOINT_NAME}\`.`,
    "",
    `- \`${ENTRYPOINT_NAME}\` is always loaded into your conversation context \u2014 lines after ${MAX_ENTRYPOINT_LINES} will be truncated, so keep the index concise`,
    "- Keep the name, description, and type fields in memory files up-to-date with the content",
    "- Organize memory semantically by topic, not chronologically",
    "- Update or remove memories that turn out to be wrong or outdated",
    "- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one."
  ].join(`
`);
  const lines = [
    AUTO_MEMORY_MARKER,
    "# Auto Memory",
    "",
    `You have a persistent, file-based memory system at \`${store.memoryDir}\`. This directory already exists \u2014 write to it directly (do not run mkdir or check for its existence).`,
    "",
    "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
    "",
    "If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.",
    "",
    TYPES_SECTION,
    WHAT_NOT_TO_SAVE,
    "",
    howToSave,
    "",
    WHEN_TO_ACCESS,
    "",
    TRUSTING_RECALL,
    "",
    PERSISTENCE_SECTION,
    "",
    ...buildSearchingPastContextSection(store.memoryDir, store.projectDir)
  ];
  if (includeIndex) {
    const indexContent = store.readIndex();
    if (indexContent.trim()) {
      const { content: truncated } = truncateEntrypoint(indexContent);
      lines.push(`## ${ENTRYPOINT_NAME}`, "", truncated);
    } else {
      lines.push(`## ${ENTRYPOINT_NAME}`, "", `Your ${ENTRYPOINT_NAME} is currently empty. When you save new memories, they will appear here.`);
    }
  }
  if (recalledMemoriesSection?.trim()) {
    lines.push("", recalledMemoriesSection);
  }
  return lines.join(`
`);
}

// node_modules/opencode-claude-memory/dist/hooks/messages.js
function roleOf(message) {
  return String(message.info?.role ?? "");
}
function partText(part) {
  if (!part || typeof part !== "object")
    return;
  const text = part.text;
  return typeof text === "string" ? text : undefined;
}
function extractUserQuery(message) {
  if (!Array.isArray(message.parts))
    return;
  const text = message.parts.filter((part) => part.type === "text").map((part) => partText(part) ?? "").filter(Boolean).join(`
`).trim();
  return text || undefined;
}
function getLastUserQuery(messages) {
  for (let i = messages.length - 1;i >= 0; i--) {
    const message = messages[i];
    if (!message || roleOf(message) !== "user")
      continue;
    const info = message.info;
    return {
      query: extractUserQuery(message),
      sessionID: typeof info?.sessionID === "string" ? info.sessionID : undefined,
      messageID: typeof info?.id === "string" ? info.id : undefined,
      messageIndex: i
    };
  }
  return {};
}
function buildTurnID(sessionID, turn) {
  return `${sessionID}:${turn.messageID ?? `${turn.messageIndex ?? -1}:${turn.query ?? ""}`}`;
}
function extractSurfacedMemoryKeys(systemText) {
  const keys = new Set;
  const recalledSection = systemText.indexOf(RECALLED_MEMORIES_HEADING);
  if (recalledSection === -1)
    return keys;
  const headerPattern = /^### (.+?) \((\w+)\)/gm;
  const section = systemText.slice(recalledSection);
  for (let match = headerPattern.exec(section);match !== null; match = headerPattern.exec(section)) {
    keys.add(`${match[1]}|${match[2]}`);
  }
  return keys;
}
function collectSurfacedMemoryKeys(messages) {
  const keys = new Set;
  for (const message of messages) {
    if (roleOf(message) !== "system" || !Array.isArray(message.parts))
      continue;
    for (const part of message.parts) {
      const text = partText(part);
      if (!text)
        continue;
      for (const key of extractSurfacedMemoryKeys(text))
        keys.add(key);
    }
  }
  return keys;
}
function extractRecentTools(messages) {
  const tools = [];
  const seen = new Set;
  for (const message of messages) {
    if (!Array.isArray(message.parts))
      continue;
    for (const part of message.parts) {
      if (!part || typeof part !== "object")
        continue;
      const p = part;
      if (p.type !== "tool" || !p.tool)
        continue;
      if (p.state?.status !== "completed")
        continue;
      if (seen.has(p.tool))
        continue;
      seen.add(p.tool);
      tools.push(p.tool);
    }
  }
  return tools;
}

// node_modules/opencode-claude-memory/dist/util/legacyShellHook.js
import { readFileSync as readFileSync4 } from "fs";
import { join as join4 } from "path";
var V1_HOOK_START_MARKER = "# >>> opencode-memory auto-initialization >>>";
var V1_HOOK_RC_FILES = [".zshrc", ".bashrc", ".bash_profile", ".profile"];
function findLegacyShellHooks(homeDir) {
  const found = [];
  for (const name of V1_HOOK_RC_FILES) {
    const path = join4(homeDir, name);
    try {
      if (readFileSync4(path, "utf-8").includes(V1_HOOK_START_MARKER))
        found.push(path);
    } catch {}
  }
  return found;
}

// node_modules/opencode-claude-memory/dist/util/log.js
var LOG_SERVICE = "opencode-claude-memory";
function getErrorMessage(error) {
  if (error instanceof Error)
    return error.message;
  if (error && typeof error === "object") {
    const message = error.message;
    if (typeof message === "string")
      return message;
  }
  return String(error);
}
function createLogger(client, directory) {
  return (level, message, extra) => {
    const log = client?.app?.log;
    if (typeof log !== "function")
      return;
    try {
      Promise.resolve(log.call(client?.app, {
        body: { service: LOG_SERVICE, level, message, extra },
        query: { directory }
      })).catch(() => {});
    } catch {}
  };
}

// node_modules/opencode-claude-memory/dist/extraction/lock.js
import { randomBytes as randomBytes2 } from "crypto";
import { readFileSync as readFileSync5, renameSync as renameSync2, unlinkSync as unlinkSync2, writeFileSync as writeFileSync2 } from "fs";

// node_modules/opencode-claude-memory/dist/util/exclusiveFile.js
import { randomBytes } from "crypto";
import { chmodSync, linkSync, lstatSync as lstatSync2, mkdirSync, realpathSync as realpathSync2, renameSync, statSync as statSync3, unlinkSync, writeFileSync } from "fs";
import { dirname as dirname2 } from "path";
function errorCode(error) {
  return error?.code;
}
function createExclusiveSync(path, content) {
  mkdirSync(dirname2(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, content, "utf-8");
  try {
    linkSync(tmp, path);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST")
      return false;
    try {
      writeFileSync(path, content, { encoding: "utf-8", flag: "wx" });
      return true;
    } catch (fallbackError) {
      if (errorCode(fallbackError) === "EEXIST")
        return false;
      throw fallbackError;
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}
function writeFileAtomicSync(path, content, rename = renameSync) {
  const link = isSymbolicLink(path);
  const target = link ? replaceableLinkTarget(path) : path;
  if (target === undefined) {
    writeFileSync(path, content, "utf-8");
    return;
  }
  mkdirSync(dirname2(path), { recursive: true });
  const mode = existingMode(target);
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, content, { encoding: "utf-8", mode });
  } catch (error) {
    unlinkWithRetry(tmp);
    if (!link || !TEMP_REFUSED_CODES.includes(errorCode(error) ?? ""))
      throw error;
    writeFileSync(path, content, "utf-8");
    return;
  }
  let renamed = false;
  try {
    if (mode !== undefined)
      restoreMode(tmp, mode);
    renamed = renameWithRetry(tmp, target, rename);
    if (!renamed)
      writeFileSync(target, content, "utf-8");
  } finally {
    if (!renamed)
      unlinkWithRetry(tmp);
  }
}
var TEMP_REFUSED_CODES = ["EACCES", "EPERM", "EROFS"];
function isSymbolicLink(path) {
  try {
    return lstatSync2(path).isSymbolicLink();
  } catch {
    return false;
  }
}
function replaceableLinkTarget(path) {
  try {
    const target = realpathSync2(path);
    return statSync3(target).isFile() ? target : undefined;
  } catch (error) {
    return errorCode(error) === "ELOOP" ? path : undefined;
  }
}
function existingMode(path) {
  try {
    return statSync3(path).mode & 4095;
  } catch {
    return;
  }
}
function restoreMode(path, mode) {
  try {
    chmodSync(path, mode);
  } catch {}
}
var RENAME_BUSY_CODES = ["EPERM", "EBUSY", "EACCES"];
var RENAME_ATTEMPTS = 5;
function renameWithRetry(tmp, target, rename) {
  for (let attempt = 1;attempt <= RENAME_ATTEMPTS; attempt++) {
    try {
      rename(tmp, target);
      return true;
    } catch (error) {
      if (process.platform !== "win32" || !RENAME_BUSY_CODES.includes(errorCode(error) ?? ""))
        throw error;
      if (attempt < RENAME_ATTEMPTS)
        sleepSync(2 * attempt);
    }
  }
  return false;
}
function fileAgeMs(path, now = Date.now()) {
  try {
    return now - statSync3(path).mtimeMs;
  } catch {
    return;
  }
}
function sleepSync(ms) {
  const until = Date.now() + Math.max(0, ms);
  while (Date.now() < until) {}
}
function unlinkWithRetry(path, attempts = 5) {
  for (let i = 0;i < attempts; i++) {
    try {
      unlinkSync(path);
      return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT")
        return true;
      if (i < attempts - 1)
        sleepSync(2);
    }
  }
  return false;
}
var FILE_LOCK_TIMEOUT_MS = 5000;
var FILE_LOCK_STALE_MS = 1e4;
function withFileLock(lockPath, fn, options = {}) {
  const timeoutMs = options.timeoutMs ?? FILE_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? FILE_LOCK_STALE_MS;
  const deadline = Date.now() + timeoutMs;
  for (;; ) {
    if (createExclusiveSync(lockPath, String(process.pid))) {
      try {
        return fn();
      } finally {
        unlinkWithRetry(lockPath);
      }
    }
    const age = fileAgeMs(lockPath);
    if (age !== undefined && age > staleMs) {
      unlinkWithRetry(lockPath);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for lock ${lockPath}`);
    }
    sleepSync(2 + Math.floor(Math.random() * 8));
  }
}

// node_modules/opencode-claude-memory/dist/extraction/lock.js
var MAINTENANCE_STALE_LOCK_MS = 10 * 60 * 1000;
var MAINTENANCE_HEARTBEAT_MS = 60 * 1000;
var LOCK_INIT_GRACE_MS = 5000;
var REAP_LOCK_STALE_MS = 30000;
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

class MaintenanceLock {
  lockPath;
  now;
  pid;
  alive;
  token;
  heartbeat;
  constructor(lockPath, now = Date.now, pid = process.pid, alive = isProcessAlive) {
    this.lockPath = lockPath;
    this.now = now;
    this.pid = pid;
    this.alive = alive;
  }
  get held() {
    return this.token !== undefined;
  }
  readHolder() {
    let raw;
    try {
      raw = readFileSync5(this.lockPath, "utf-8");
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.pid !== "number" || typeof parsed.token !== "string")
        return "unreadable";
      const startedAt = typeof parsed.startedAt === "number" ? parsed.startedAt : 0;
      const heartbeatAt = typeof parsed.heartbeatAt === "number" ? parsed.heartbeatAt : startedAt;
      return { pid: parsed.pid, token: parsed.token, startedAt, heartbeatAt };
    } catch {
      return "unreadable";
    }
  }
  isLive(holder) {
    if (holder === undefined)
      return false;
    if (holder === "unreadable") {
      const age = fileAgeMs(this.lockPath);
      return age !== undefined && age < LOCK_INIT_GRACE_MS;
    }
    if (holder.pid !== this.pid && !this.alive(holder.pid))
      return false;
    return this.now() - holder.heartbeatAt < MAINTENANCE_STALE_LOCK_MS;
  }
  isHeld() {
    return this.isLive(this.readHolder());
  }
  tryAcquire() {
    if (this.held)
      return true;
    const token = randomBytes2(8).toString("hex");
    for (let attempt = 0;attempt < 2; attempt++) {
      const now = this.now();
      const content = { pid: this.pid, token, startedAt: now, heartbeatAt: now };
      if (createExclusiveSync(this.lockPath, JSON.stringify(content))) {
        this.token = token;
        this.startHeartbeat();
        return true;
      }
      const holder = this.readHolder();
      if (this.isLive(holder))
        return false;
      if (!this.reap(holder))
        return false;
    }
    return false;
  }
  reap(seen) {
    const reapPath = `${this.lockPath}.reap`;
    if (!createExclusiveSync(reapPath, String(this.pid))) {
      const age = fileAgeMs(reapPath);
      if (age === undefined || age < REAP_LOCK_STALE_MS)
        return false;
      try {
        unlinkSync2(reapPath);
      } catch {
        return false;
      }
      if (!createExclusiveSync(reapPath, String(this.pid)))
        return false;
    }
    try {
      const current = this.readHolder();
      if (current === undefined)
        return true;
      if (this.isLive(current))
        return false;
      if (current !== "unreadable" && seen !== "unreadable" && seen !== undefined && current.token !== seen.token) {
        return false;
      }
      unlinkSync2(this.lockPath);
      return true;
    } catch {
      return false;
    } finally {
      try {
        unlinkSync2(reapPath);
      } catch {}
    }
  }
  refresh() {
    if (!this.token)
      return false;
    const holder = this.readHolder();
    if (holder === undefined || holder === "unreadable" || holder.token !== this.token)
      return false;
    const next = { ...holder, heartbeatAt: this.now() };
    const tmp = `${this.lockPath}.${this.pid}.${this.token}.hb`;
    try {
      writeFileSync2(tmp, JSON.stringify(next), "utf-8");
      renameSync2(tmp, this.lockPath);
      return true;
    } catch {
      try {
        unlinkSync2(tmp);
      } catch {}
      return false;
    }
  }
  release() {
    this.stopHeartbeat();
    const token = this.token;
    this.token = undefined;
    if (!token)
      return;
    const holder = this.readHolder();
    if (holder === undefined || holder === "unreadable" || holder.token !== token)
      return;
    unlinkWithRetry(this.lockPath);
  }
  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => void this.refresh(), MAINTENANCE_HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }
  stopHeartbeat() {
    if (this.heartbeat)
      clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
}

// node_modules/opencode-claude-memory/dist/extraction/autodream.js
var AUTODREAM_TITLE = "opencode-memory auto-dream";
var AUTODREAM_FORK_GRACE_MS = 60000;
function shouldRunAutodream(state, gate, now) {
  const hoursSince = (now - state.lastConsolidatedAt) / (60 * 60 * 1000);
  if (hoursSince < gate.minHours)
    return false;
  return state.sessionsSince.length >= gate.minSessions;
}

class AutoDream {
  deps;
  now;
  lock;
  constructor(deps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.lock = deps.lock ?? new MaintenanceLock(deps.state.lockPath, this.now);
  }
  static noteSession(state, sessionID) {
    if (!state.sessionsSince.includes(sessionID))
      state.sessionsSince.push(sessionID);
  }
  shouldRun() {
    const { config, state } = this.deps;
    if (!config.autodream.enabled)
      return false;
    return shouldRunAutodream(state.read().autodream, config.autodream, this.now());
  }
  async maybeRun(parentSessionID) {
    if (!this.shouldRun())
      return false;
    if (!this.lock.tryAcquire()) {
      this.deps.log("info", "Auto-dream skipped: another process holds the maintenance lock");
      return false;
    }
    const { client, config, directory, owned, agents, state, log } = this.deps;
    try {
      if (!this.shouldRun())
        return false;
      const autodream = state.read().autodream;
      log("info", "Auto-dream consolidation starting", {
        sessionsSince: autodream.sessionsSince.length,
        lastConsolidatedAt: autodream.lastConsolidatedAt
      });
      await runForkSession({
        client,
        directory,
        parentSessionID,
        title: AUTODREAM_TITLE,
        agent: config.agents.dream,
        system: AUTODREAM_PROMPT,
        tools: agents.toolsFor(config.agents.dream),
        parts: [{ type: "text", text: AUTODREAM_USER_MESSAGE }],
        timeoutMs: config.autodream.timeoutMs,
        onCreated: (id) => owned.add(id),
        onFinished: (id) => owned.release(id, AUTODREAM_FORK_GRACE_MS),
        onCleanupFailed: (id, stage, error) => log("warn", "Auto-dream fork cleanup failed; the server may still hold the fork session", {
          forkID: id,
          stage,
          error: getErrorMessage(error)
        })
      });
      state.update((data) => {
        data.autodream.lastConsolidatedAt = this.now();
        data.autodream.sessionsSince = [];
      });
      log("info", "Auto-dream consolidation completed");
      return true;
    } catch (error) {
      log("error", "Auto-dream consolidation failed", { error: getErrorMessage(error) });
      return false;
    } finally {
      this.lock.release();
    }
  }
}

// node_modules/opencode-claude-memory/dist/extraction/state.js
import { existsSync, mkdirSync as mkdirSync2, readFileSync as readFileSync6, renameSync as renameSync3, statSync as statSync4, unlinkSync as unlinkSync3, writeFileSync as writeFileSync3 } from "fs";
import { join as join5 } from "path";
var EXTRACTION_STATE_VERSION = 1;
var EXTRACTION_STATE_FILE = "extraction-state.json";
var MAINTENANCE_LOCK_FILE = "maintenance.lock";
var STATE_LOCK_FILE = "extraction-state.lock";
var SESSION_STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
function emptyExtractionState() {
  return { version: EXTRACTION_STATE_VERSION, sessions: {}, autodream: { lastConsolidatedAt: 0, sessionsSince: [] } };
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normaliseSession(value) {
  if (!isRecord(value))
    return;
  const updatedAt = typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : 0;
  const failures = typeof value.failures === "number" && Number.isFinite(value.failures) ? value.failures : 0;
  const state = { updatedAt, failures };
  if (typeof value.lastExtractedMessageID === "string")
    state.lastExtractedMessageID = value.lastExtractedMessageID;
  if (typeof value.lastMessageAt === "number" && Number.isFinite(value.lastMessageAt))
    state.lastMessageAt = value.lastMessageAt;
  if (typeof value.attemptedAt === "number" && Number.isFinite(value.attemptedAt))
    state.attemptedAt = value.attemptedAt;
  return state;
}
function parseExtractionState(raw) {
  const data = emptyExtractionState();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return data;
  }
  if (!isRecord(parsed))
    return data;
  if (isRecord(parsed.sessions)) {
    for (const [id, value] of Object.entries(parsed.sessions)) {
      const session = normaliseSession(value);
      if (session)
        data.sessions[id] = session;
    }
  }
  if (isRecord(parsed.autodream)) {
    const last = parsed.autodream.lastConsolidatedAt;
    if (typeof last === "number" && Number.isFinite(last))
      data.autodream.lastConsolidatedAt = last;
    if (Array.isArray(parsed.autodream.sessionsSince)) {
      data.autodream.sessionsSince = parsed.autodream.sessionsSince.filter((s) => typeof s === "string");
    }
  }
  return data;
}

class ExtractionStateStore {
  stateDir;
  now;
  filePath;
  lockPath;
  stateLockPath;
  constructor(stateDir, now = Date.now) {
    this.stateDir = stateDir;
    this.now = now;
    this.filePath = join5(stateDir, EXTRACTION_STATE_FILE);
    this.lockPath = join5(stateDir, MAINTENANCE_LOCK_FILE);
    this.stateLockPath = join5(stateDir, STATE_LOCK_FILE);
  }
  read() {
    let raw = "";
    try {
      raw = readFileSync6(this.filePath, "utf-8");
    } catch {}
    return parseExtractionState(raw);
  }
  getSession(sessionID) {
    return this.read().sessions[sessionID];
  }
  update(mutate) {
    mkdirSync2(this.stateDir, { recursive: true });
    return withFileLock(this.stateLockPath, () => {
      const data = this.read();
      mutate(data);
      this.prune(data);
      this.write(data);
      return data;
    });
  }
  prune(data) {
    const cutoff = this.now() - SESSION_STATE_TTL_MS;
    for (const [id, session] of Object.entries(data.sessions)) {
      if (Math.max(session.updatedAt, session.attemptedAt ?? 0) < cutoff)
        delete data.sessions[id];
    }
  }
  write(data) {
    mkdirSync2(this.stateDir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync3(tmp, `${JSON.stringify(data, null, 2)}
`, "utf-8");
    renameSync3(tmp, this.filePath);
  }
}
function posixCksum(input) {
  const bytes = Buffer.from(input, "utf-8");
  let crc = 0;
  const feed = (byte) => {
    crc ^= byte << 24;
    for (let i = 0;i < 8; i++) {
      crc = crc & 2147483648 ? (crc << 1 ^ 79764919) >>> 0 : crc << 1 >>> 0;
    }
  };
  for (const byte of bytes)
    feed(byte);
  let length = bytes.length;
  while (length > 0) {
    feed(length & 255);
    length >>>= 8;
  }
  return ~crc >>> 0 >>> 0;
}
function migrateLegacyAutodreamState(store, legacyDir, projectRoots) {
  if (store.read().autodream.lastConsolidatedAt > 0)
    return false;
  let migrated = false;
  for (const root of new Set(projectRoots)) {
    const legacyPath = join5(legacyDir, `${posixCksum(root)}.consolidate-lock`);
    if (!existsSync(legacyPath))
      continue;
    try {
      const mtimeMs = statSync4(legacyPath).mtimeMs;
      store.update((data) => {
        data.autodream.lastConsolidatedAt = Math.max(data.autodream.lastConsolidatedAt, Math.floor(mtimeMs));
      });
      unlinkSync3(legacyPath);
      migrated = true;
    } catch {}
  }
  return migrated;
}

// node_modules/opencode-claude-memory/dist/extraction/ExtractionCoordinator.js
var EXTRACTION_TITLE = "opencode-memory extraction";
var FORK_GRACE_MS = 60000;
var MAX_EXTRACTION_FAILURES = 3;
var MIN_CONVERSATION_CHARS = 20;
var SDK_READ_TIMEOUT_MS = 30000;
function messageTime(message) {
  const time = message.info?.time;
  return {
    created: typeof time?.created === "number" ? time.created : undefined,
    completed: typeof time?.completed === "number" ? time.completed : undefined
  };
}
function sliceNewMessages(messages, state) {
  if (!state)
    return [...messages];
  if (state.lastExtractedMessageID) {
    const idx = messages.findIndex((m) => m.info.id === state.lastExtractedMessageID);
    if (idx >= 0)
      return messages.slice(idx + 1);
  }
  const boundary = state.lastMessageAt ?? state.updatedAt;
  return messages.filter((m) => (messageTime(m).created ?? 0) > boundary);
}
function trimIncompleteTail(messages) {
  let end = messages.length;
  while (end > 0) {
    const message = messages[end - 1];
    if (!message || roleOf(message) !== "assistant" || messageTime(message).completed !== undefined)
      break;
    end -= 1;
  }
  return messages.slice(0, end);
}
function hasExtractableUserMessage(messages) {
  return messages.some((message) => {
    if (roleOf(message) !== "user" || !Array.isArray(message.parts))
      return false;
    return message.parts.some((part) => {
      const p = part;
      return p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0 && !p.synthetic;
    });
  });
}
function buildConversationForExtraction(messages, maxChars) {
  const lines = [];
  for (const message of messages) {
    const role = roleOf(message);
    if (!role || !Array.isArray(message.parts))
      continue;
    for (const part of message.parts) {
      const p = part;
      if (p.type === "text" && typeof p.text === "string" && !p.synthetic) {
        lines.push(`### ${role === "user" ? "User" : "Assistant"}
${p.text}`);
      } else if (p.type === "tool" && p.tool && p.state?.status === "completed" && typeof p.state.output === "string") {
        const out = p.state.output.length > 300 ? `${p.state.output.slice(0, 300)}\u2026` : p.state.output;
        lines.push(`_[tool ${p.tool}: ${out}]_`);
      }
    }
  }
  let text = lines.join(`

`);
  if (text.length > maxChars) {
    text = `\u2026[older turns truncated]

${text.slice(-maxChars)}`;
  }
  return text;
}

class ExtractionCoordinator {
  deps;
  state;
  autodream;
  lock;
  now;
  timers = new Map;
  busy = new Set;
  inFlight = new Set;
  savedByFork = new Map;
  savedByMainAgent = new Set;
  queue = Promise.resolve();
  caughtUp = false;
  disposed = false;
  constructor(deps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.state = deps.state ?? new ExtractionStateStore(deps.store.stateDir, this.now);
    this.lock = deps.lock ?? new MaintenanceLock(this.state.lockPath, this.now);
    this.autodream = deps.client ? new AutoDream({ ...deps, client: deps.client, state: this.state, now: this.now, lock: this.lock }) : undefined;
  }
  get enabled() {
    return this.deps.config.extract.enabled && this.deps.client !== undefined;
  }
  onEvent(event) {
    if (event.type === "session.idle")
      this.onSessionIdle(event.properties.sessionID);
    else if (event.type === "session.deleted")
      this.onSessionDeleted(event.properties.info.id);
    else if (event.type === "session.status")
      this.onSessionStatus(event.properties.sessionID, event.properties.status.type);
  }
  onSessionIdle(sessionID) {
    if (!this.enabled || this.disposed || !sessionID)
      return;
    if (this.deps.owned.has(sessionID))
      return;
    this.busy.delete(sessionID);
    this.clearTimer(sessionID);
    const timer = setTimeout(() => {
      this.timers.delete(sessionID);
      this.enqueue(sessionID);
    }, this.deps.config.extract.debounceMs);
    timer.unref?.();
    this.timers.set(sessionID, timer);
  }
  onSessionStatus(sessionID, status) {
    if (!sessionID || this.deps.owned.has(sessionID))
      return;
    if (status === "idle") {
      this.busy.delete(sessionID);
      return;
    }
    this.busy.add(sessionID);
    this.clearTimer(sessionID);
  }
  onSessionDeleted(sessionID) {
    this.clearTimer(sessionID);
    this.busy.delete(sessionID);
    this.savedByMainAgent.delete(sessionID);
  }
  recordSave(sessionID, fileName) {
    if (!sessionID)
      return;
    const fork = this.savedByFork.get(sessionID);
    if (fork) {
      fork.push(fileName);
      return fork;
    }
    if (!this.deps.owned.has(sessionID))
      this.savedByMainAgent.add(sessionID);
    return;
  }
  isOwnedSession(sessionID) {
    return this.deps.owned.has(sessionID);
  }
  idle() {
    return this.queue;
  }
  async catchUp() {
    if (this.caughtUp || !this.enabled)
      return;
    this.caughtUp = true;
    const { client, config, directory, store, log } = this.deps;
    if (!client)
      return;
    this.warnLegacyShellHook();
    migrateLegacyAutodreamState(this.state, `${store.claudeConfigDir}/opencode-memory`, [
      store.gitRoot ?? store.memoryRoot,
      store.memoryRoot,
      store.canonicalRoot
    ]);
    if (config.extract.catchUpLimit <= 0)
      return;
    let sessions;
    try {
      sessions = unwrapData(await withDeadline("session.list", SDK_READ_TIMEOUT_MS, (signal) => client.session.list({ query: { directory }, signal }))) ?? [];
    } catch (error) {
      log("warn", "Extraction catch-up could not list sessions", { error: getErrorMessage(error) });
      return;
    }
    const pending = sessions.filter((session) => !session.parentID && !this.deps.owned.has(session.id)).filter((session) => {
      const known = this.state.getSession(session.id);
      const boundary = known?.lastMessageAt ?? known?.updatedAt ?? 0;
      return (session.time?.updated ?? 0) > boundary;
    }).sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0)).slice(0, config.extract.catchUpLimit);
    for (const session of pending)
      await this.enqueue(session.id);
  }
  dispose() {
    this.disposed = true;
    for (const timer of this.timers.values())
      clearTimeout(timer);
    this.timers.clear();
    this.busy.clear();
  }
  clearTimer(sessionID) {
    const existing = this.timers.get(sessionID);
    if (existing)
      clearTimeout(existing);
    this.timers.delete(sessionID);
  }
  warnLegacyShellHook() {
    let hooks;
    try {
      hooks = findLegacyShellHooks(this.deps.config.homeDir);
    } catch {
      return;
    }
    if (hooks.length === 0)
      return;
    this.deps.log("warn", "v1 opencode-memory shell hook is still installed; v2 extracts in-process, so run `opencode-memory uninstall` (or delete the marked block) to avoid a second, competing extraction", {
      files: hooks
    });
  }
  enqueue(sessionID) {
    const run = this.queue.then(() => this.runIncremental(sessionID)).catch(() => {});
    this.queue = run;
    return run;
  }
  snapshot(messages, previous) {
    const fresh = trimIncompleteTail(sliceNewMessages(messages, previous));
    const last = fresh[fresh.length - 1];
    if (!last || !hasExtractableUserMessage(fresh))
      return;
    return { fresh, last, lastMessageAt: messageTime(last).created };
  }
  advance(sessionID, snapshot, extra = {}) {
    let advanced = false;
    this.state.update((data) => {
      const current = data.sessions[sessionID];
      if (current?.lastMessageAt !== undefined && snapshot.lastMessageAt !== undefined && current.lastMessageAt > snapshot.lastMessageAt) {
        return;
      }
      advanced = true;
      data.sessions[sessionID] = {
        lastExtractedMessageID: snapshot.last.info.id,
        ...snapshot.lastMessageAt !== undefined ? { lastMessageAt: snapshot.lastMessageAt } : {},
        updatedAt: this.now(),
        failures: 0,
        ...extra
      };
      AutoDream.noteSession(data.autodream, sessionID);
    });
    return advanced;
  }
  async runIncremental(sessionID) {
    const { client, config, store, directory, owned, agents, log } = this.deps;
    if (!client || this.disposed || this.inFlight.has(sessionID))
      return;
    if (this.busy.has(sessionID))
      return;
    this.inFlight.add(sessionID);
    try {
      const response = await withDeadline("session.messages", SDK_READ_TIMEOUT_MS, (signal) => client.session.messages({ path: { id: sessionID }, query: { directory }, signal }));
      const messages = unwrapData(response) ?? [];
      if (this.busy.has(sessionID))
        return;
      let snapshot = this.snapshot(messages, this.state.getSession(sessionID));
      if (!snapshot)
        return;
      if (this.savedByMainAgent.delete(sessionID)) {
        if (this.advance(sessionID, snapshot))
          await this.autodream?.maybeRun(sessionID);
        return;
      }
      if (buildConversationForExtraction(snapshot.fresh, config.extract.maxConversationChars).trim().length < MIN_CONVERSATION_CHARS) {
        this.advance(sessionID, snapshot);
        return;
      }
      if (!this.lock.tryAcquire()) {
        log("info", "Memory extraction skipped: another process holds the maintenance lock", { sessionID });
        return;
      }
      let extracted = false;
      try {
        const previous = this.state.getSession(sessionID);
        snapshot = this.snapshot(messages, previous);
        if (!snapshot)
          return;
        const conversation = buildConversationForExtraction(snapshot.fresh, config.extract.maxConversationChars);
        if (conversation.trim().length < MIN_CONVERSATION_CHARS) {
          this.advance(sessionID, snapshot);
          return;
        }
        try {
          await runForkSession({
            client,
            directory,
            parentSessionID: sessionID,
            title: EXTRACTION_TITLE,
            agent: config.agents.extract,
            system: buildExtractionSystemPrompt(store.manifest()),
            tools: agents.toolsFor(config.agents.extract),
            parts: [{ type: "text", text: conversation }],
            timeoutMs: config.extract.timeoutMs,
            onCreated: (forkID) => {
              owned.add(forkID);
              this.savedByFork.set(forkID, []);
            },
            onFinished: (forkID) => {
              owned.release(forkID, FORK_GRACE_MS);
              const cleanup = setTimeout(() => this.savedByFork.delete(forkID), FORK_GRACE_MS);
              cleanup.unref?.();
            },
            onCleanupFailed: (forkID, stage, error) => log("warn", "Extraction fork cleanup failed; the server may still hold the fork session", {
              forkID,
              stage,
              sessionID,
              error: getErrorMessage(error)
            })
          });
        } catch (error) {
          const failures = (previous?.failures ?? 0) + 1;
          log("error", "Memory extraction failed", { error: getErrorMessage(error), sessionID, failures });
          if (failures >= MAX_EXTRACTION_FAILURES) {
            this.advance(sessionID, snapshot);
          } else {
            this.state.update((data) => {
              data.sessions[sessionID] = {
                ...data.sessions[sessionID] ?? previous ?? { updatedAt: 0 },
                failures,
                attemptedAt: this.now()
              };
            });
          }
          return;
        }
        extracted = this.advance(sessionID, snapshot);
      } finally {
        this.lock.release();
      }
      if (extracted)
        await this.autodream?.maybeRun(sessionID);
    } catch (error) {
      const detail = error instanceof TimeoutError ? error.message : getErrorMessage(error);
      log("error", "Memory extraction failed", { error: detail, sessionID });
    } finally {
      this.inFlight.delete(sessionID);
    }
  }
}

// node_modules/opencode-claude-memory/dist/recall/format.js
var MAX_MEMORY_LINES = 200;
var MAX_MEMORY_BYTES = 4096;
var encoder = new TextEncoder;
function truncateMemoryContent(content) {
  const maxLines = content.split(`
`).slice(0, MAX_MEMORY_LINES);
  const lineTruncated = maxLines.join(`
`);
  if (encoder.encode(lineTruncated).length <= MAX_MEMORY_BYTES) {
    return lineTruncated;
  }
  const lines = lineTruncated.split(`
`);
  const kept = [];
  let usedBytes = 0;
  for (const line of lines) {
    const candidate = kept.length === 0 ? line : `
${line}`;
    const candidateBytes = encoder.encode(candidate).length;
    if (usedBytes + candidateBytes > MAX_MEMORY_BYTES)
      break;
    kept.push(line);
    usedBytes += candidateBytes;
  }
  return kept.join(`
`);
}
function recalledMemoryFromHeader(header, content, now) {
  return {
    fileName: header.filename,
    filePath: header.filePath,
    name: header.name,
    type: header.type,
    description: header.description,
    content: truncateMemoryContent(content),
    ageInDays: Math.max(0, Math.floor((now - header.mtimeMs) / (1000 * 60 * 60 * 24)))
  };
}
function recallSelectedMemories(headers, selectedFilenames, alreadySurfaced = new Set, options = {}) {
  if (selectedFilenames.length === 0)
    return [];
  const maxMemories = options.maxMemories ?? 5;
  const now = options.now ?? Date.now();
  const byFilename = new Map(headers.map((header) => [header.filename, header]));
  const recalled = [];
  const seen = new Set;
  for (const filename of selectedFilenames) {
    if (seen.has(filename))
      continue;
    seen.add(filename);
    const header = byFilename.get(filename);
    if (!header || alreadySurfaced.has(surfaceKey(header)))
      continue;
    recalled.push(recalledMemoryFromHeader(header, readMemoryBody(header.filePath), now));
    if (recalled.length >= maxMemories)
      break;
  }
  return recalled;
}
function formatAgeWarning(ageInDays) {
  if (ageInDays <= 1)
    return "";
  return `
> This memory is ${ageInDays} days old. Memories are point-in-time observations, not live state \u2014 claims about code behavior or file:line citations may be outdated. Verify against current code before asserting as fact.
`;
}
function formatRecalledMemories(memories) {
  if (memories.length === 0)
    return "";
  const sections = memories.map((memory) => {
    const ageWarning = formatAgeWarning(memory.ageInDays);
    return `### ${memory.name} (${memory.type})${ageWarning}
${memory.content}`;
  });
  return [
    RECALLED_MEMORIES_HEADING,
    "",
    "The following memories were automatically selected as relevant to this conversation. They may be outdated \u2014 verify against current state before relying on them.",
    "",
    sections.join(`

`)
  ].join(`
`);
}

// node_modules/opencode-claude-memory/dist/hooks/ignore.js
function detectIgnoreMemory(query) {
  if (!query)
    return false;
  const normalized = query.toLowerCase();
  return /(ignore|don't use|do not use|without|skip)\s+(the\s+|your\s+)?memory/.test(normalized) || /memory\s+(should be|must be)?\s*ignored/.test(normalized);
}
function detectResumeMemory(query) {
  if (!query)
    return false;
  const normalized = query.toLowerCase();
  return /(use|enable|resume|restore|bring back|turn on)\s+(the\s+|your\s+)?memory(\s+again)?/.test(normalized) || /memory\s+(back\s+)?on\b/.test(normalized) || /stop ignoring\s+(the\s+|your\s+)?memory/.test(normalized);
}
function deriveIgnoredFromHistory(messages) {
  let ignored = false;
  for (const message of messages) {
    if (roleOf(message) !== "user")
      continue;
    const query = extractUserQuery(message);
    if (detectIgnoreMemory(query))
      ignored = true;
    else if (ignored && detectResumeMemory(query))
      ignored = false;
  }
  return ignored;
}
function isAutoMemoryPart(part) {
  if (!part || typeof part !== "object")
    return false;
  const text = part.text;
  return typeof text === "string" && text.trimStart().startsWith(AUTO_MEMORY_MARKER);
}
function stripAutoMemoryParts(messages) {
  return messages.map((message) => {
    if (roleOf(message) !== "system" || !Array.isArray(message.parts))
      return message;
    const parts = message.parts.filter((part) => !isAutoMemoryPart(part));
    return parts.length === message.parts.length ? message : { ...message, parts };
  }).filter((message) => !Array.isArray(message.parts) || message.parts.length > 0);
}

// node_modules/opencode-claude-memory/dist/recall/RecallCoordinator.js
var SESSION_STATE_TTL_MS2 = 60 * 60 * 1000;
var SELECTOR_GRACE_MS = 60000;
var TIMEOUT = Symbol("recall-timeout");
function isUsefulRecallQuery(query) {
  const trimmed = query?.trim();
  if (!trimmed)
    return false;
  if (/\s/.test(trimmed))
    return true;
  return /[\u3400-\u9FFF]/.test(trimmed) && trimmed.length >= 4;
}

class RecallCoordinator {
  deps;
  sessions = new Map;
  warnedMissingSessionID = false;
  now;
  constructor(deps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }
  onMessagesTransform(output) {
    const turn = getLastUserQuery(output.messages);
    const { sessionID } = turn;
    if (!sessionID) {
      if (detectIgnoreMemory(turn.query))
        output.messages = stripAutoMemoryParts(output.messages);
      return;
    }
    if (this.deps.owned.has(sessionID))
      return;
    const now = this.now();
    this.evictStale(now);
    const state = this.sessions.get(sessionID) ?? {
      updatedAt: now,
      ignored: deriveIgnoredFromHistory(output.messages)
    };
    state.updatedAt = now;
    const turnID = buildTurnID(sessionID, turn);
    if (state.turnID !== turnID) {
      if (detectIgnoreMemory(turn.query))
        state.ignored = true;
      else if (state.ignored && detectResumeMemory(turn.query))
        state.ignored = false;
      state.turnID = turnID;
      state.prefetch = state.ignored ? undefined : this.startPrefetch(sessionID, turnID, turn.query, output.messages);
    }
    this.sessions.set(sessionID, state);
    if (state.ignored)
      output.messages = stripAutoMemoryParts(output.messages);
  }
  async takeRecalled(sessionID) {
    if (!sessionID) {
      if (!this.warnedMissingSessionID) {
        this.warnedMissingSessionID = true;
        this.deps.log("warn", "system.transform received no sessionID; memory recall is disabled for this call");
      }
      return [];
    }
    const state = this.sessions.get(sessionID);
    const prefetch = state?.prefetch;
    if (!state || state.ignored || !prefetch || prefetch.consumed)
      return [];
    const result = await this.race(prefetch.promise, this.deps.config.recall.waitMs);
    if (result === TIMEOUT)
      return [];
    prefetch.consumed = true;
    return result;
  }
  isIgnored(sessionID) {
    return sessionID !== undefined && this.sessions.get(sessionID)?.ignored === true;
  }
  onEvent(event) {
    if (event.type === "session.deleted")
      this.sessions.delete(event.properties.info.id);
  }
  get trackedSessions() {
    return this.sessions.size;
  }
  race(promise, waitMs) {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), waitMs);
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer)
        clearTimeout(timer);
    });
  }
  evictStale(now) {
    const cutoff = now - SESSION_STATE_TTL_MS2;
    for (const [id, state] of this.sessions) {
      if (state.updatedAt >= cutoff)
        continue;
      if (state.ignored) {
        state.prefetch = undefined;
        state.turnID = undefined;
      } else {
        this.sessions.delete(id);
      }
    }
  }
  startPrefetch(sessionID, turnID, query, messages) {
    const { client, config, store, owned, agents, directory } = this.deps;
    if (!config.recall.enabled || !client || !isUsefulRecallQuery(query))
      return;
    const alreadySurfaced = collectSurfacedMemoryKeys(messages);
    const recentTools = extractRecentTools(messages);
    const headers = store.scan().filter((header) => !alreadySurfaced.has(surfaceKey(header)));
    if (headers.length === 0)
      return;
    const promise = selectRelevantMemoryFilenames({
      client,
      directory,
      parentSessionID: sessionID,
      query,
      memories: headers,
      recentTools,
      agent: config.agents.recall,
      tools: agents.toolsFor(config.agents.recall),
      timeoutMs: config.recall.timeoutMs,
      maxMemories: config.recall.maxMemories,
      onSessionCreated: (id) => owned.add(id),
      onSessionFinished: (id) => owned.release(id, SELECTOR_GRACE_MS)
    }).then((selected) => recallSelectedMemories(headers, selected, alreadySurfaced, { maxMemories: config.recall.maxMemories })).catch(() => []);
    return { turnID, promise, consumed: false };
  }
}

// node_modules/opencode-claude-memory/dist/store/MemoryStore.js
import { cpSync, lstatSync as lstatSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync7, realpathSync as realpathSync3, statSync as statSync5, unlinkSync as unlinkSync4 } from "fs";
import { dirname as dirname3, join as join6 } from "path";
class MemoryStore {
  memoryRoot;
  gitRoot;
  canonicalRoot;
  claudeConfigDir;
  projectDir;
  memoryDir;
  entrypoint;
  stateDir;
  now;
  constructor(memoryRoot, options) {
    this.memoryRoot = memoryRoot;
    this.gitRoot = findGitRoot(memoryRoot);
    this.canonicalRoot = findCanonicalGitRoot(memoryRoot) ?? memoryRoot;
    this.claudeConfigDir = options.claudeConfigDir;
    this.now = options.now ?? (() => new Date);
    const projectKey = sanitizePath(this.canonicalRoot);
    this.projectDir = join6(this.claudeConfigDir, "projects", projectKey);
    this.memoryDir = join6(this.projectDir, "memory");
    this.entrypoint = join6(this.memoryDir, ENTRYPOINT_NAME);
    this.stateDir = join6(this.claudeConfigDir, "opencode-memory", projectKey);
    mkdirSync3(this.memoryDir, { recursive: true });
  }
  scan() {
    return scanMemoryFiles(this.memoryDir);
  }
  manifest() {
    return formatMemoryManifest(this.scan());
  }
  list(options = {}) {
    const entries = [];
    for (const header of this.scan()) {
      const entry = readMemoryEntry(this.memoryDir, header.filename);
      if (entry)
        entries.push(entry);
    }
    if ((options.sort ?? "name") === "name") {
      entries.sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0);
    }
    return entries;
  }
  read(fileName) {
    const { relativePath } = resolveMemoryFilePath(this.memoryDir, fileName);
    return readMemoryEntry(this.memoryDir, relativePath);
  }
  save(input) {
    const { relativePath, filePath } = resolveMemoryFilePath(this.memoryDir, input.fileName);
    if (typeof input.name !== "string" || !input.name.trim()) {
      throw new Error("Memory name is required");
    }
    if (isLinkTo(filePath, this.entrypoint)) {
      throw new Error(`Memory "${relativePath}" is a link to ${ENTRYPOINT_NAME}; saving it would overwrite the index`);
    }
    const existing = readTextFile(filePath);
    const parsed = existing === null ? null : parseFrontmatter(existing);
    const pointer = buildIndexPointer(relativePath, input.name, input.description);
    if (parsed !== null && this.isUnchanged(parsed, relativePath, input, pointer)) {
      return { filePath, fileName: relativePath, unchanged: true };
    }
    const modified = this.now().toISOString();
    const fileContent = existing === null || parsed === null ? `${buildFrontmatter({ ...input, modified })}

${input.content.trim()}
` : updatedFileContent(existing, parsed, input, modified);
    if (Buffer.byteLength(fileContent, "utf-8") > MAX_MEMORY_FILE_BYTES) {
      throw new Error(`Memory file content exceeds the ${MAX_MEMORY_FILE_BYTES}-byte limit`);
    }
    if (!parseFrontmatter(fileContent).hasFrontmatter) {
      throw new Error(`Memory "${relativePath}" frontmatter would exceed ${FRONTMATTER_MAX_LINES} lines; trim its frontmatter first`);
    }
    writeFileAtomicSync(filePath, fileContent);
    this.writeIndex(upsertIndexLine(this.readIndex(), relativePath, pointer));
    return { filePath, fileName: relativePath, unchanged: false };
  }
  delete(fileName) {
    const { relativePath, filePath } = resolveMemoryFilePath(this.memoryDir, fileName);
    const existing = readTextFile(filePath);
    if (existing === null)
      return { deleted: false };
    let trashedTo;
    if (!isPurelyOwn(existing, filePath)) {
      const stamp = this.now().toISOString().replace(/[:.]/g, "-");
      trashedTo = join6(this.stateDir, "trash", stamp, relativePath);
      mkdirSync3(dirname3(trashedTo), { recursive: true });
      cpSync(filePath, trashedTo, { preserveTimestamps: true });
    }
    try {
      unlinkSync4(filePath);
    } catch {
      return { deleted: false };
    }
    this.writeIndex(removeIndexLine(this.readIndex(), relativePath));
    return trashedTo ? { deleted: true, trashedTo } : { deleted: true };
  }
  search(query) {
    const lowerQuery = query.toLowerCase();
    return this.list().filter((entry) => entry.name.toLowerCase().includes(lowerQuery) || entry.description.toLowerCase().includes(lowerQuery) || entry.body.toLowerCase().includes(lowerQuery));
  }
  readIndex() {
    return readIndexFile(this.entrypoint);
  }
  writeIndex(content) {
    writeFileAtomicSync(this.entrypoint, content);
  }
  isUnchanged(parsed, relativePath, input, pointer) {
    const { frontmatter, body, hasFrontmatter } = parsed;
    if (!hasFrontmatter)
      return false;
    const same = (frontmatter.name ?? nameFromFilename(relativePath)) === input.name && (frontmatter.description ?? "") === input.description && (parseMemoryType(frontmatter.type) ?? "user") === input.type && body.replace(/\r\n/g, `
`) === input.content.trim().replace(/\r\n/g, `
`);
    return same && indexHasPointer(this.readIndex(), pointer);
  }
}
var OWN_KEYS = ["name", "description", "metadata", "type", "origin", "modified"];
var OWN_WRITE_SLACK_MS = 2000;
function isPurelyOwn(content, filePath) {
  const keys = frontmatterKeys(content);
  if (keys?.length !== OWN_KEYS.length || !OWN_KEYS.every((key) => keys.includes(key)))
    return false;
  const { frontmatter } = parseFrontmatter(content);
  if (frontmatter.origin !== ORIGIN)
    return false;
  const stamped = Date.parse(frontmatter.modified ?? "");
  if (Number.isNaN(stamped))
    return false;
  try {
    return Math.abs(statSync5(filePath).mtimeMs - stamped) <= OWN_WRITE_SLACK_MS;
  } catch {
    return false;
  }
}
function isLinkTo(path, other) {
  try {
    return lstatSync3(path).isSymbolicLink() && realpathSync3(path) === realpathSync3(other);
  } catch {
    return false;
  }
}
function readTextFile(path) {
  try {
    return readFileSync7(path, "utf-8");
  } catch {
    return null;
  }
}
function updatedFileContent(existing, parsed, input, modified) {
  return editFrontmatter(existing, {
    set: { name: input.name, description: input.description },
    setWhereExists: { type: input.type, modified },
    setMeta: parsed.frontmatter.origin === ORIGIN ? {} : { updatedBy: ORIGIN },
    body: input.content
  });
}

// node_modules/opencode-claude-memory/dist/tools.js
import { tool } from "@opencode-ai/plugin";
function formatMemorySaveResult(outcome, savedThisRun) {
  const inExtractionRun = savedThisRun !== undefined;
  const savedEarlierThisRun = inExtractionRun && savedThisRun.indexOf(outcome.fileName) < savedThisRun.length - 1;
  let head;
  if (outcome.unchanged) {
    head = savedEarlierThisRun ? `Skipped: "${outcome.fileName}" was already saved earlier in this extraction run with identical content \u2014 nothing written.` : `Skipped: "${outcome.fileName}" already exists with identical content \u2014 nothing written (${outcome.filePath}).`;
  } else if (savedEarlierThisRun) {
    head = `Updated "${outcome.fileName}" (first saved earlier in this extraction run) at ${outcome.filePath}`;
  } else {
    head = `Memory saved to ${outcome.filePath}`;
  }
  if (!inExtractionRun)
    return head;
  const unique = Array.from(new Set(savedThisRun));
  return `${head}

` + `Saved so far in this extraction run (${unique.length}): ${unique.join(", ")}
` + "These memories are already persisted \u2014 do not call memory_save for them again. " + "Once every distinct memory worth keeping is saved, stop calling tools and reply with a one-line summary.";
}
function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
function memorySaveTitle(type, name) {
  if (type && name)
    return `${type}: ${name}`;
  return name || undefined;
}
function memoryListTitle(count) {
  return plural(count, "memory", "memories");
}
function memorySearchTitle(query, count) {
  return `"${query}" \xB7 ${plural(count, "match", "matches")}`;
}
var FILE_NAME_HINT = 'with or without the .md extension; sub-directories are allowed, e.g. "team/conventions"';
function buildMemoryTools(store, extraction) {
  return {
    memory_save: tool({
      description: "Save or update a memory for future conversations. " + "Each memory is stored as a markdown file with frontmatter. " + "Use this when the user explicitly asks you to remember something, " + "or when you observe important information worth preserving across sessions " + "(user preferences, feedback, project context, external references). " + "Check existing memories first with memory_list or memory_search to avoid duplicates.",
      args: {
        file_name: tool.schema.string().describe('File name for the memory (without .md extension). Use snake_case, e.g. "user_role", "feedback_testing_style", "project_auth_rewrite"; a sub-directory prefix such as "team/conventions" is allowed'),
        name: tool.schema.string().describe("Human-readable name for this memory"),
        description: tool.schema.string().describe("One-line description \u2014 used to decide relevance in future conversations, so be specific"),
        type: tool.schema.enum(MEMORY_TYPES).describe("Memory type: user (about the person), feedback (guidance on approach), project (ongoing work context), reference (pointers to external systems)"),
        content: tool.schema.string().describe("Memory content. For feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines")
      },
      async execute(args, ctx) {
        const outcome = store.save({
          fileName: args.file_name,
          name: args.name,
          description: args.description,
          type: args.type,
          content: args.content
        });
        const savedThisRun = extraction.recordSave(ctx?.sessionID, outcome.fileName);
        return {
          title: memorySaveTitle(args.type, args.name),
          output: formatMemorySaveResult(outcome, savedThisRun)
        };
      }
    }),
    memory_delete: tool({
      description: "Delete a memory that is outdated, wrong, or no longer relevant. Also removes it from the index.",
      args: {
        file_name: tool.schema.string().describe(`File name of the memory to delete (${FILE_NAME_HINT})`)
      },
      async execute(args) {
        const { deleted, trashedTo } = store.delete(args.file_name);
        let output = `Memory "${args.file_name}" not found.`;
        if (deleted) {
          output = trashedTo ? `Memory "${args.file_name}" deleted (a copy was kept at ${trashedTo}).` : `Memory "${args.file_name}" deleted.`;
        }
        return { title: args.file_name, output };
      }
    }),
    memory_list: tool({
      description: "List all saved memories with their names, types, and descriptions. " + "Use this to check what memories exist before saving a new one (to avoid duplicates) " + "or when you need to recall what's been stored.",
      args: {},
      async execute() {
        const entries = store.list();
        const title = memoryListTitle(entries.length);
        if (entries.length === 0)
          return { title, output: "No memories saved yet." };
        const lines = entries.map((e) => `- **${e.name}** (${e.type}) [${e.filename}]: ${e.description}`);
        return { title, output: `${entries.length} memories found:
${lines.join(`
`)}` };
      }
    }),
    memory_search: tool({
      description: "Search memories by keyword. Searches across names, descriptions, and content. " + "Use this to find relevant memories before answering questions or when the user references past conversations.",
      args: {
        query: tool.schema.string().describe("Search query \u2014 searches across name, description, and content")
      },
      async execute(args) {
        const results = store.search(args.query);
        const title = memorySearchTitle(args.query, results.length);
        if (results.length === 0)
          return { title, output: `No memories matching "${args.query}".` };
        const lines = results.map((e) => `- **${e.name}** (${e.type}) [${e.filename}]: ${e.description}
  Content: ${e.body.slice(0, 200)}${e.body.length > 200 ? "..." : ""}`);
        return { title, output: `${results.length} matches for "${args.query}":
${lines.join(`
`)}` };
      }
    }),
    memory_read: tool({
      description: "Read the full content of a specific memory file.",
      args: {
        file_name: tool.schema.string().describe(`File name of the memory to read (${FILE_NAME_HINT})`)
      },
      async execute(args) {
        const entry = store.read(args.file_name);
        if (!entry)
          return { title: args.file_name, output: `Memory "${args.file_name}" not found.` };
        return {
          title: args.file_name,
          output: `# ${entry.name}
**Type:** ${entry.type}
**Description:** ${entry.description}

${entry.body}`
        };
      }
    })
  };
}

// node_modules/opencode-claude-memory/dist/util/ownedSessions.js
class OwnedSessions {
  timers = new Map;
  add(id) {
    const existing = this.timers.get(id);
    if (existing)
      clearTimeout(existing);
    this.timers.set(id, undefined);
  }
  has(id) {
    return id !== undefined && this.timers.has(id);
  }
  release(id, graceMs) {
    if (!this.timers.has(id))
      return;
    const existing = this.timers.get(id);
    if (existing)
      clearTimeout(existing);
    if (graceMs <= 0) {
      this.timers.delete(id);
      return;
    }
    const timer = setTimeout(() => this.timers.delete(id), graceMs);
    timer.unref?.();
    this.timers.set(id, timer);
  }
  dispose() {
    for (const timer of this.timers.values()) {
      if (timer)
        clearTimeout(timer);
    }
    this.timers.clear();
  }
}

// node_modules/opencode-claude-memory/dist/index.js
var PLUGIN_ID = "opencode-claude-memory";
var createMemoryPlugin = (env, homeDir) => async ({ worktree, directory, client }, options) => {
  const config = parseConfig(options, env, homeDir);
  const dir = directory ?? worktree;
  const store = new MemoryStore(resolveMemoryRoot(worktree, dir), config);
  const log = createLogger(client, dir);
  const owned = new OwnedSessions;
  const agents = new AgentRegistry(config.agents);
  const deps = { store, config, client, directory: dir, owned, agents, log };
  const recall = new RecallCoordinator(deps);
  const extraction = new ExtractionCoordinator(deps);
  return {
    memory: { store, recall, config, owned },
    config: async (cfg) => {
      agents.register(cfg);
      extraction.catchUp();
    },
    event: async ({ event }) => {
      if (event.type === "session.deleted")
        owned.release(event.properties.info.id, 5000);
      recall.onEvent(event);
      extraction.onEvent(event);
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      recall.onMessagesTransform(output);
    },
    "experimental.chat.system.transform": async ({ sessionID }, output) => {
      if (owned.has(sessionID))
        return;
      const recalled = await recall.takeRecalled(sessionID);
      output.system.push(buildMemorySystemPrompt(store, formatRecalledMemories(recalled), {
        includeIndex: !recall.isIgnored(sessionID)
      }));
    },
    tool: buildMemoryTools(store, extraction),
    dispose: async () => {
      extraction.dispose();
      owned.dispose();
    }
  };
};
var MemoryPlugin = createMemoryPlugin();
var plugin = { id: PLUGIN_ID, server: MemoryPlugin };
var dist_default = plugin;
export {
  MEMORY_AGENTS,
  MemoryOptionsSchema,
  MemoryPlugin,
  MemoryStore,
  PLUGIN_ID,
  buildMemorySystemPrompt,
  createMemoryPlugin,
  dist_default as default,
  formatRecalledMemories,
  recallSelectedMemories
};

//# debugId=9A1B6CE1F9E8162D64756E2164756E21
