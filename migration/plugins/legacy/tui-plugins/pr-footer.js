// @bun
// ../../../../../../../.config/opencode/tui-plugins/pr-footer.js
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
async function lookup(dir) {
  const branch = await branchOf(dir).catch(() => "");
  if (!branch || SKIP_BRANCHES.has(branch))
    return;
  const key = `${dir}\x00${branch}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS)
    return hit.value;
  const value = run("gh", [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "all",
    "--limit",
    "1",
    "--json",
    "number,url,state,isDraft"
  ], { cwd: dir, timeout: 15000 }).then(({ stdout }) => {
    const pr = JSON.parse(stdout)[0];
    if (!pr)
      return;
    return {
      number: pr.number,
      url: pr.url,
      state: pr.isDraft && pr.state === "OPEN" ? "draft" : pr.state.toLowerCase()
    };
  }).catch(() => {
    return;
  });
  cache.set(key, { at: Date.now(), value });
  return value;
}
function PrFooter(props) {
  const { api, options } = props;
  const [pr, setPr] = createSignal();
  let generation = 0;
  const refresh = async (sessionID) => {
    const mine = ++generation;
    const dir = api.state.session.get(sessionID)?.directory ?? api.state.path.directory;
    const value = await lookup(dir);
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
      const text = createElement("text");
      setProp(text, "wrapMode", "none");
      setProp(text, "onMouseUp", () => void run("open", [p.url]).catch(() => {}));
      insert(text, `#${p.number}`);
      effect((prev) => setProp(text, "fg", stateColor(p), prev));
      return text;
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
  pr_footer_default as default
};

//# debugId=F8CD4A16510B858864756E2164756E21
