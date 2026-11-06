// @bun
// ../../../../.config/opencode/tui-plugins/pr-footer.js
import { createElement, createTextNode, effect, insert, insertNode, setProp, createComponent } from "@opentui/solid";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { execFile } from "child_process";
import { promisify } from "util";
var run = promisify(execFile);
var DEFAULTS = { interval_ms: 60000 };
var CACHE_MS = 15000;
var cache = new Map;
var SKIP_BRANCHES = new Set(["HEAD", "main", "master", "dev", "develop"]);
async function branchOf(dir) {
  const { stdout } = await run("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
  return stdout.trim();
}
var PR_COMMAND = /\bgh\s+pr\s+(?:create|merge|ready|close|reopen|edit)\b/;
var PR_URL = /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/;
var PR_ARG = /\bgh\s+pr\s+(?:merge|ready|close|reopen|edit)\s+(?:\S+\/pull\/)?(\d+)/;
function commandDir(input) {
  if (typeof input?.workdir === "string" && input.workdir)
    return input.workdir;
  const cd = /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/.exec(input?.command ?? "");
  return cd?.[1].replace(/^["']|["']$/g, "");
}
function scan(messages) {
  const events = [];
  for (const message of messages) {
    if (message.type !== "assistant")
      continue;
    for (const part of message.content ?? []) {
      const input = part.type === "tool" && part.name === "shell" ? part.state?.input : undefined;
      if (typeof input?.command !== "string")
        continue;
      const dir = commandDir(input);
      const output = (part.state.content ?? []).map((item) => item.text ?? "").join(`
`);
      const url = PR_COMMAND.test(input.command) ? PR_URL.exec(output) ?? PR_URL.exec(input.command) : undefined;
      const number = url?.[2] ?? (PR_COMMAND.test(input.command) ? PR_ARG.exec(input.command)?.[1] : undefined);
      events.push({ dir, pr: number ? { repo: url?.[1], number: Number(number) } : undefined });
    }
  }
  return events.reverse();
}
async function isLinkedWorktree(dir) {
  if (!dir)
    return false;
  const [git, common] = await Promise.all(["--git-dir", "--git-common-dir"].map((flag) => run("git", ["-C", dir, "rev-parse", "--path-format=absolute", flag]).then(({ stdout }) => stdout.trim()))).catch(() => []);
  return Boolean(git && git !== common);
}
function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS)
    return hit.value;
  const value = load().catch(() => {
    return;
  });
  cache.set(key, { at: Date.now(), value });
  return value;
}
var pull = (pr) => ({
  branch: pr.headRefName,
  number: pr.number,
  url: pr.url,
  state: pr.isDraft && pr.state === "OPEN" ? "draft" : pr.state.toLowerCase()
});
var byNumber = (root, found) => cached(`${root}\x00#${found.repo ?? ""}${found.number}`, () => run("gh", ["pr", "view", String(found.number), ...found.repo ? ["--repo", found.repo] : [], "--json", "number,url,state,isDraft,headRefName"], { cwd: root, timeout: 15000 }).then(({ stdout }) => pull(JSON.parse(stdout))));
var byBranch = async (dir) => {
  const branch = await branchOf(dir).catch(() => "");
  if (!branch || SKIP_BRANCHES.has(branch))
    return;
  return cached(`${dir}\x00${branch}`, () => run("gh", ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", "number,url,state,isDraft,headRefName"], {
    cwd: dir,
    timeout: 15000
  }).then(({ stdout }) => {
    const pr = JSON.parse(stdout)[0];
    return pr ? pull(pr) : undefined;
  }));
};
var remembered = new Map;
async function lookup(root, messages, sessionID) {
  for (const event of scan(messages)) {
    if (event.pr) {
      const pr = await byNumber(root, event.pr);
      if (pr) {
        remembered.set(sessionID, event.pr);
        return pr;
      }
    }
    if (await isLinkedWorktree(event.dir))
      return byBranch(event.dir);
  }
  const earlier = remembered.get(sessionID);
  return earlier && await byNumber(root, earlier) || byBranch(root);
}
function PrFooter(props) {
  const { api, options } = props;
  const [pr, setPr] = createSignal();
  let generation = 0;
  const refresh = async (sessionID) => {
    const mine = ++generation;
    const root = api.state.session.get(sessionID)?.directory ?? api.state.path.directory;
    const value = await lookup(root, api.state.session.messages?.(sessionID) ?? [], sessionID);
    if (mine === generation)
      setPr(value);
  };
  createEffect(() => {
    const sessionID = props.sessionID;
    setPr(undefined);
    refresh(sessionID);
  });
  const timer = setInterval(() => void refresh(props.sessionID), options.interval_ms);
  const off = api.event.on("session.idle", (event) => {
    if (event.properties?.sessionID !== props.sessionID)
      return;
    cache.clear();
    refresh(props.sessionID);
  });
  onCleanup(() => {
    generation++;
    clearInterval(timer);
    off();
  });
  const MERGED = "#8957e5";
  const stateColor = (p) => {
    const t = api.theme.current;
    if (p.state === "merged")
      return MERGED;
    if (p.state === "closed")
      return t.error;
    if (p.state === "draft")
      return t.textMuted;
    return t.success;
  };
  const root = createElement("box");
  insert(root, createComponent(Show, {
    get when() {
      return pr();
    },
    keyed: true,
    children: (p) => {
      const row = createElement("box");
      setProp(row, "flexDirection", "row");
      setProp(row, "gap", 1);
      if (p.branch) {
        const name = createElement("text");
        setProp(name, "wrapMode", "none");
        insert(name, p.branch.length > 28 ? p.branch.slice(0, 27) + "\u2026" : p.branch);
        effect((prev) => setProp(name, "fg", api.theme.current.textMuted, prev));
        insertNode(row, name);
      }
      const text = createElement("text");
      setProp(text, "wrapMode", "none");
      setProp(text, "onMouseUp", () => void run("open", [p.url]).catch(() => {}));
      insert(text, `#${p.number}`);
      effect((prev) => setProp(text, "fg", stateColor(p), prev));
      insertNode(row, text);
      return row;
    }
  }));
  return root;
}
var tui = async (api, rawOptions) => {
  if (typeof api.slots?.register !== "function")
    return;
  const options = { ...DEFAULTS, ...rawOptions ?? {} };
  api.slots.register({
    order: 100,
    slots: {
      session_prompt_footer(_ctx, props) {
        return createComponent(PrFooter, {
          api,
          options,
          get sessionID() {
            return props.session_id;
          }
        });
      }
    }
  });
};
var pr_footer_default = { id: "pr-footer", tui };
export {
  pr_footer_default as default,
  lookup,
  scan
};

//# debugId=6E96280777D2FE5564756E2164756E21
