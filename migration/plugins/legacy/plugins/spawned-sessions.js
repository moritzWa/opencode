// @bun
// ../../../../../../../.config/opencode/plugins/spawned-sessions.js
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
var WINDOW_MS = 2 * 60 * 1000;
var ID = /ses_[A-Za-z0-9]+/g;
function linksFile() {
  const state = process.env.XDG_STATE_HOME?.startsWith("/") ? process.env.XDG_STATE_HOME : join(homedir(), ".local", "state");
  return join(state, "agentview", "opencode", "session-parents.jsonl");
}
function loadLinked(path) {
  const linked = new Set;
  if (!existsSync(path))
    return linked;
  for (const line of readFileSync(path, "utf8").split(`
`)) {
    try {
      const child = JSON.parse(line)?.child;
      if (typeof child === "string")
        linked.add(child);
    } catch {}
  }
  return linked;
}
var SpawnedSessions = async () => {
  const path = linksFile();
  const linked = loadLinked(path);
  const recent = new Map;
  const parents = new Map;
  function root(id) {
    let current = id;
    for (let hops = 0;hops < 8; hops++) {
      const parent = parents.get(current);
      if (!parent)
        return current;
      current = parent;
    }
    return current;
  }
  function prune(now) {
    for (const [id, at] of recent)
      if (now - at > WINDOW_MS)
        recent.delete(id);
  }
  return {
    event: async ({ event }) => {
      if (event.type !== "session.created")
        return;
      const info = event.properties?.info;
      if (!info?.id)
        return;
      if (info.parentID) {
        parents.set(info.id, info.parentID);
        return;
      }
      const now = Date.now();
      prune(now);
      recent.set(info.id, now);
    },
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "bash" || !input.sessionID)
        return;
      const now = Date.now();
      prune(now);
      if (recent.size === 0)
        return;
      const text = `${output?.output ?? ""}
${output?.metadata?.output ?? ""}`;
      const parent = root(input.sessionID);
      const lines = [];
      for (const id of new Set(text.match(ID) ?? [])) {
        if (id === parent || id === input.sessionID)
          continue;
        if (!recent.has(id) || linked.has(id))
          continue;
        linked.add(id);
        lines.push(JSON.stringify({ child: id, parent, at: now }));
      }
      if (lines.length === 0)
        return;
      try {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, lines.join(`
`) + `
`);
      } catch {}
    }
  };
};
export {
  SpawnedSessions
};

//# debugId=BF0FDB78E95437C864756E2164756E21
