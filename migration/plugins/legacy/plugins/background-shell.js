// @bun
// ../../../../../../../.config/opencode/plugins/background-shell.js
import { spawnSync } from "child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "fs";
import { homedir } from "os";
var HOLD_DIR = `${process.env.XDG_STATE_HOME || `${homedir()}/.local/state`}/agentview/holds/opencode`;
var PREFIX = "bg-";
var POLL_MS = 5000;
var IDENTITY_EVERY = 12;
var HOLD_TTL_MS = 24 * 3600000;
var MAX_AGE_MS = 6 * 3600000;
var TAIL_LINES = 30;
var TAIL_BYTES = 64 * 1024;
var PID_PATTERNS = [
  /__CURSOR_BACKGROUND_SHELL__(\d+):([^\r\n]+)/,
  /__CURSOR_SHELL_BACKGROUND__(\d+):([^\r\n]+)/,
  /in the background \(pid (\d+)\)/
];
var BACKGROUNDS = /(?:^|[^&>])&\s*(?:$|[;\n)]|echo\b)|\bnohup\b|\bdisown\b|\bsetsid\b/;
var SETTLE_MS = 1500;
var CLOCK_SLACK_MS = 2000;
var sleep = (ms) => new Promise((done) => setTimeout(done, ms));
var seconds = (ms) => `${Math.round(ms / 1000)}s`;
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
function unwrapped(command) {
  const body = /\bnohup\s+(?:ba)?sh\s+-c\s+'((?:[^']|'\\'')*)'/.exec(command)?.[1];
  return body === undefined ? command : body.replaceAll("'\\''", "'").trim();
}
function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 4000 });
  return result.status === 0 ? result.stdout : "";
}
function startToken(pid) {
  return run("ps", ["-o", "lstart=", "-p", String(pid)]).trim();
}
function elapsedMs(pid) {
  const text = run("ps", ["-o", "etime=", "-p", String(pid)]).trim();
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text);
  if (!match)
    return;
  const [, days = 0, hours = 0, minutes, secs] = match;
  return (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(secs)) * 1000;
}
function stdoutPath(pid) {
  if (process.platform === "linux") {
    try {
      return readlinkSync(`/proc/${pid}/fd/1`);
    } catch {
      return;
    }
  }
  const line = run("lsof", ["-a", "-p", String(pid), "-d", "1", "-Fn"]).split(`
`).find((entry) => entry.startsWith("n/"));
  return line?.slice(1);
}
function tail(path) {
  if (!path)
    return [];
  try {
    const size = statSync(path).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    const lines = buffer.toString("utf8").split(`
`);
    if (lines.at(-1) === "")
      lines.pop();
    if (size > length)
      lines.shift();
    return lines.slice(-TAIL_LINES);
  } catch {
    return [];
  }
}
function processes() {
  const rows = [];
  for (const line of run("ps", ["-axo", "pid=,ppid=,pgid=,lstart=,command="]).split(`
`)) {
    const fields = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*\S)\s*$/.exec(line);
    if (!fields)
      continue;
    rows.push({
      pid: Number(fields[1]),
      ppid: Number(fields[2]),
      pgid: Number(fields[3]),
      start: fields[4],
      startedAt: Date.parse(fields[4]),
      command: fields[5]
    });
  }
  return rows;
}
function leftovers(since) {
  const rows = processes();
  const live = new Map(rows.map((row) => [row.pid, row]));
  return rows.filter((row) => row.pid !== row.pgid && !live.has(row.pgid) && live.get(row.ppid)?.pgid !== row.pgid && row.startedAt >= since - CLOCK_SLACK_MS);
}
function reported(text) {
  if (typeof text !== "string")
    return;
  for (const pattern of PID_PATTERNS) {
    const match = pattern.exec(text);
    if (!match)
      continue;
    const pid = Number(match[1]);
    if (Number.isSafeInteger(pid) && pid > 1)
      return { pid, log: match[2]?.trim() };
  }
  return;
}
var BackgroundShell = async ({ client }) => {
  const watched = new Map;
  const calls = new Map;
  let polls = 0;
  let timer;
  let disposed = false;
  const settleTimers = new Set;
  function holdPath(sessionID, pid) {
    return `${HOLD_DIR}/${sessionID}/${PREFIX}${process.pid}-${pid}.json`;
  }
  function save(shell) {
    try {
      mkdirSync(`${HOLD_DIR}/${shell.sessionID}`, { recursive: true });
      writeFileSync(shell.path, JSON.stringify({
        pid: shell.pid,
        reason: `shell: ${shell.command.slice(0, 60)}`,
        expires_ms: shell.startedAt + HOLD_TTL_MS,
        owner: process.pid,
        released: shell.released === true,
        start: shell.start,
        started_ms: shell.startedAt,
        command: shell.command,
        log: shell.log,
        wake: shell.wake
      }));
    } catch {}
  }
  function track({ pid, start, startedAt, command, log, root, sessionID }) {
    const path = holdPath(root, pid);
    if (watched.has(path))
      return;
    const shell = {
      pid,
      start,
      startedAt,
      command,
      log,
      sessionID: root,
      wake: root,
      subagent: root === sessionID ? undefined : sessionID,
      path
    };
    save(shell);
    watched.set(path, shell);
    ensureTimer();
  }
  async function sweep(since, sessionID) {
    const found = leftovers(since).filter((left) => !alive(left.pgid));
    if (found.length === 0)
      return;
    const root = await rootOf(sessionID);
    for (const left of found.slice(0, 4)) {
      track({
        pid: left.pid,
        start: left.start,
        startedAt: left.startedAt,
        command: left.command,
        log: stdoutPath(left.pid),
        root,
        sessionID
      });
    }
  }
  async function rootOf(sessionID) {
    let id = sessionID;
    for (let depth = 0;depth < 8; depth++) {
      const session = await client.session.get({ path: { id } }).catch(() => {
        return;
      });
      const parent = session?.data?.parentID;
      if (!parent)
        return id;
      id = parent;
    }
    return id;
  }
  async function wake(shell) {
    const ran = seconds((shell.endedAt ?? Date.now()) - shell.startedAt);
    const lines = tail(shell.log);
    const detail = [
      `<background-shell-notification pid="${shell.pid}">`,
      "Automated notification: a shell you started in the background has exited. It is not a message from the user.",
      `command: ${shell.command}`,
      `ran for: about ${ran} (exit code not available)`,
      ...shell.subagent ? [`started by subagent session ${shell.subagent}`] : [],
      lines.length ? `last ${lines.length} lines of output:` : "no output was captured.",
      ...lines,
      ...shell.log ? [`full output: ${shell.log}`] : [],
      "Carry on with whatever you were waiting on it for. If you stopped it yourself or no longer need it, end your turn without doing anything.",
      "</background-shell-notification>"
    ].join(`
`);
    const request = {
      path: { id: shell.wake },
      body: {
        parts: [
          { type: "text", text: `[background shell] exited after ${ran}: ${shell.command.slice(0, 120)}` },
          { type: "text", text: detail, synthetic: true }
        ]
      }
    };
    for (let attempt = 0;attempt < 3; attempt++) {
      try {
        const result = await client.session.promptAsync(request);
        if (!result?.error)
          return;
      } catch {}
      await sleep(2000);
    }
  }
  async function finish(shell) {
    shell.endedAt = Date.now();
    watched.delete(shell.path);
    rmSync(shell.path, { force: true });
    await sleep(1000);
    await wake(shell);
  }
  function adopt() {
    let sessions;
    try {
      sessions = readdirSync(HOLD_DIR);
    } catch {
      return;
    }
    for (const session of sessions) {
      let files;
      try {
        files = readdirSync(`${HOLD_DIR}/${session}`).filter((file) => file.startsWith(PREFIX) && file.endsWith(".json"));
      } catch {
        continue;
      }
      for (const file of files) {
        const from = `${HOLD_DIR}/${session}/${file}`;
        if (watched.has(from))
          continue;
        let hold;
        try {
          hold = JSON.parse(readFileSync(from, "utf8"));
        } catch {
          continue;
        }
        if (!hold?.pid || !hold.owner || !hold.released && (hold.owner === process.pid || alive(hold.owner)))
          continue;
        const to = holdPath(session, hold.pid);
        try {
          renameSync(from, to);
        } catch {
          continue;
        }
        const shell = {
          pid: hold.pid,
          start: hold.start,
          startedAt: hold.started_ms ?? Date.now(),
          command: hold.command ?? "",
          log: hold.log,
          sessionID: session,
          wake: hold.wake ?? session,
          path: to
        };
        save(shell);
        watched.set(to, shell);
        if (!alive(shell.pid) || startToken(shell.pid) !== shell.start)
          finish(shell);
      }
    }
  }
  async function poll() {
    if (disposed)
      return;
    polls++;
    const identity = polls % IDENTITY_EVERY === 0;
    for (const shell of [...watched.values()]) {
      if (!alive(shell.pid) || identity && startToken(shell.pid) !== shell.start)
        await finish(shell);
    }
    if (!identity)
      return;
    for (const [callID, at] of calls)
      if (Date.now() - at > MAX_AGE_MS)
        calls.delete(callID);
    adopt();
  }
  function ensureTimer() {
    if (timer)
      return;
    timer = setInterval(() => void poll(), POLL_MS);
    timer.unref?.();
  }
  adopt();
  ensureTimer();
  return {
    dispose: async () => {
      disposed = true;
      for (const pending of settleTimers)
        clearTimeout(pending);
      settleTimers.clear();
      for (const shell of watched.values()) {
        shell.released = true;
        save(shell);
      }
      clearInterval(timer);
      timer = undefined;
    },
    event: async ({ event }) => {
      if (event.type !== "session.deleted")
        return;
      const id = event.properties?.info?.id;
      for (const shell of [...watched.values()]) {
        if (shell.wake !== id)
          continue;
        watched.delete(shell.path);
        rmSync(shell.path, { force: true });
      }
    },
    "tool.execute.before": async (input) => {
      if (input.tool === "bash")
        calls.set(input.callID, Date.now());
    },
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "bash")
        return;
      const began = calls.get(input.callID);
      calls.delete(input.callID);
      const command = String(output?.title || input.args?.command || "").trim();
      const found = reported(output?.output) ?? reported(output?.metadata?.output);
      if (found && alive(found.pid) && found.pid !== process.pid) {
        const age = elapsedMs(found.pid);
        const start = age === undefined || age > MAX_AGE_MS ? undefined : startToken(found.pid);
        if (start) {
          track({
            pid: found.pid,
            start,
            startedAt: Date.now() - age,
            command: unwrapped(command),
            log: found.log || stdoutPath(found.pid),
            root: await rootOf(input.sessionID),
            sessionID: input.sessionID
          });
          return;
        }
      }
      if (began === undefined || !BACKGROUNDS.test(command))
        return;
      const pending = setTimeout(() => {
        settleTimers.delete(pending);
        if (!disposed)
          sweep(began, input.sessionID);
      }, SETTLE_MS);
      settleTimers.add(pending);
    }
  };
};
export {
  BackgroundShell
};

//# debugId=00CE1CA3FD5E92D164756E2164756E21
