// @bun
// ../../../../../../../.config/opencode/plugins/monitor.js
import { tool } from "@opencode-ai/plugin";
import { spawn, spawnSync } from "child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
var SETTINGS = `${homedir()}/.claude/settings.json`;
var LOG_DIR = `${tmpdir()}/opencode-monitor`;
var HOLD_DIR = `${process.env.XDG_STATE_HOME || `${homedir()}/.local/state`}/agentview/holds/opencode`;
var HOOK_TIMEOUT_MS = 30000;
var DEFAULT_TIMEOUT_MS = 300000;
var MAX_TIMEOUT_MS = 86400000;
var MAX_PER_SESSION = 5;
var BATCH_MS = 1000;
var MAX_EVENTS = 20;
var MAX_LINES_PER_EVENT = 40;
var TAIL_LINES = 30;
var KILL_GRACE_MS = 3000;
var REWAKE_DELAYS_MS = [60000, 180000, 600000, 1800000];
var KILL_ON_ABORT = false;
var UNBOUNDED = /tail\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*f|\btail\s+--follow|inotifywait\s+(-\S+\s+)*-\S*m|\bfswatch\b|while\s+true|while\s+:/;
var ESCAPE = /\bbreak\b|\bexit\b|\buntil\b|\bgrep\s+-m\s*\d/;
var WATCHDOG = `
pid=$1; pgid=$2; deadline=$(( $(date +%s) + $3 ))
while kill -0 "$pid" 2>/dev/null && kill -0 -- "-$pgid" 2>/dev/null && [ "$(date +%s)" -lt "$deadline" ]; do sleep 2; done
kill -0 -- "-$pgid" 2>/dev/null || exit 0
kill -TERM -- "-$pgid" 2>/dev/null; sleep 3; kill -KILL -- "-$pgid" 2>/dev/null; exit 0
`;
var HEADLESS_RUN = process.argv.slice(2).find((arg) => !arg.startsWith("-")) === "run";
var sleep = (ms) => new Promise((done) => setTimeout(done, ms));
var HOLD_FILE = /^(\d+)-(m\d+)(\.cut)?\.json$/;
var RECOVER_DELAY_MS = 5000;
var RECOVER_EVERY_MS = 60000;
var RECOVER_MAX_AGE_MS = 3600000;
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function hookCommands(toolName) {
  let settings;
  try {
    settings = JSON.parse(readFileSync(SETTINGS, "utf8"));
  } catch {
    return [];
  }
  return (settings.hooks?.PreToolUse ?? []).filter((entry) => !entry.matcher || new RegExp(`^(?:${entry.matcher})$`).test(toolName)).flatMap((entry) => entry.hooks ?? []).filter((hook) => hook.type === "command" && hook.command).map((hook) => hook.command);
}
function guard(command, description, cwd, sessionID) {
  if (UNBOUNDED.test(command) && !ESCAPE.test(command)) {
    throw new Error(`Refused: ${JSON.stringify(description)} watches with a command that cannot end on its own ` + "(tail -f / inotifywait -m / fswatch / while true, with no break or exit). Only the timeout would stop it, " + "so it would stay armed long after the thing it watched has finished. `tail -f log | grep -m 1` does not " + "fix this: if the log goes quiet after the match, tail never gets SIGPIPE. Poll in a loop and `break` " + "once the state is terminal, e.g. `until <check>; do sleep 15; done; echo DONE`.");
  }
  const warnings = [];
  const calls = [
    ["Monitor", { command, description }],
    ["Bash", { command }]
  ];
  for (const [toolName, toolInput] of calls) {
    const payload = {
      session_id: sessionID,
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_input: toolInput,
      cwd
    };
    for (const hook of hookCommands(toolName)) {
      const result = spawnSync("/bin/sh", ["-c", hook], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        cwd,
        timeout: HOOK_TIMEOUT_MS,
        env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionID }
      });
      if (result.status === 2)
        throw new Error(result.stderr?.trim() || `Blocked by hook: ${hook}`);
      if (toolName === "Monitor" && result.status === 0 && result.stderr?.trim())
        warnings.push(result.stderr.trim());
    }
  }
  return warnings;
}
function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
async function killGroup(pgid) {
  if (!groupAlive(pgid))
    return true;
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {}
  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline) {
    if (!groupAlive(pgid))
      return true;
    await sleep(100);
  }
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {}
  await sleep(200);
  return !groupAlive(pgid);
}
var seconds = (ms) => `${Math.round(ms / 1000)}s`;
var Monitor = async ({ client }) => {
  const monitors = new Map;
  const finished = [];
  const wakes = new Map;
  let counter = 0;
  mkdirSync(LOG_DIR, { recursive: true });
  function record(m, line) {
    m.tail.push(line);
    if (m.tail.length > TAIL_LINES)
      m.tail.shift();
    try {
      appendFileSync(m.logPath, `${line}
`);
    } catch {}
  }
  async function send(m, headline, body, noReply = false) {
    const detail = [
      `<monitor-notification id="${m.id}" state="${m.state}">`,
      "Automated notification from the monitor you armed with the `monitor` tool. It is not a message from the user.",
      `command: ${m.command}`,
      ...body,
      `full output: ${m.logPath}`,
      m.state === "running" ? `The monitor is still running. Call monitor_stop with id ${m.id} once you have what you need.` : "The monitor has ended and its process group is gone; there is nothing left to stop.",
      "If you were in the middle of something when this arrived, carry on from where you were; do not redo finished steps.",
      "</monitor-notification>"
    ].join(`
`);
    const request = {
      path: { id: m.sessionID },
      body: {
        agent: m.agent,
        noReply,
        parts: [
          { type: "text", text: `[monitor ${m.id}] ${m.description}: ${headline}` },
          { type: "text", text: detail, synthetic: true }
        ]
      }
    };
    for (let attempt = 0;attempt < 2; attempt++) {
      try {
        const result = await client.session.promptAsync(request);
        if (!result.error) {
          if (!noReply)
            watchWake(m, request);
          return;
        }
        record(m, `monitor: notify failed: ${JSON.stringify(result.error)}`);
      } catch (error) {
        record(m, `monitor: notify failed: ${error?.message ?? error}`);
      }
      await sleep(1000);
    }
  }
  function watchWake(m, request) {
    const previous = wakes.get(m.sessionID);
    clearTimeout(previous?.timer);
    wakes.set(m.sessionID, { m, request, attempts: previous?.attempts ?? 0 });
  }
  async function replied(sessionID) {
    const result = await client.session.messages({ path: { id: sessionID }, query: { limit: 1 } });
    const last = result.data?.at(-1);
    if (!last)
      return true;
    if (last.info.role !== "assistant")
      return false;
    if (last.info.error?.name === "MessageAbortedError")
      return true;
    return !last.info.error && last.parts.some((part) => part.type === "text" || part.type === "tool");
  }
  async function checkWake(sessionID) {
    const wake = wakes.get(sessionID);
    if (!wake || wake.timer)
      return;
    let ok;
    try {
      ok = await replied(sessionID);
    } catch {
      return;
    }
    if (ok || wake.attempts >= REWAKE_DELAYS_MS.length) {
      wakes.delete(sessionID);
      if (!ok)
        record(wake.m, "monitor: gave up re-posting the notification; no turn got through");
      return;
    }
    const delay = REWAKE_DELAYS_MS[wake.attempts++];
    record(wake.m, `monitor: the turn this notification started produced no reply; re-posting in ${seconds(delay)}`);
    wake.timer = setTimeout(async () => {
      wake.timer = undefined;
      if (wakes.get(sessionID) !== wake)
        return;
      if (await replied(sessionID).catch(() => false)) {
        wakes.delete(sessionID);
        return;
      }
      const [headline, ...rest] = wake.request.body.parts;
      const retry = {
        ...wake.request,
        body: {
          ...wake.request.body,
          parts: [{ ...headline, text: `${headline.text} (re-sent: the last turn failed before you replied)` }, ...rest]
        }
      };
      try {
        const result = await client.session.promptAsync(retry);
        if (result.error)
          throw new Error(JSON.stringify(result.error));
      } catch (error) {
        record(wake.m, `monitor: re-post failed: ${error?.message ?? error}`);
        checkWake(sessionID);
      }
    }, delay);
  }
  function flush(m) {
    clearTimeout(m.flushTimer);
    m.flushTimer = undefined;
    if (m.state !== "running" || m.pending.length === 0)
      return;
    m.events++;
    if (m.events > MAX_EVENTS) {
      finish(m, "noisy");
      return;
    }
    const lines = m.pending.splice(0);
    const shown = lines.slice(0, MAX_LINES_PER_EVENT);
    const more = lines.length - shown.length;
    send(m, shown.length === 1 ? shown[0] : `${lines.length} new lines`, [
      m.pattern ? `output matching ${m.pattern}:` : "new output:",
      ...shown,
      ...more > 0 ? [`(${more} more lines in the full output)`] : []
    ]);
  }
  function onLine(m, line, stream) {
    if (stream === "stderr") {
      record(m, `stderr: ${line}`);
      return;
    }
    record(m, line);
    if (m.state !== "running")
      return;
    if (m.pattern && !m.pattern.test(line))
      return;
    m.pending.push(line);
    m.flushTimer ??= setTimeout(() => flush(m), BATCH_MS);
  }
  function writeHold(m) {
    try {
      mkdirSync(`${HOLD_DIR}/${m.sessionID}`, { recursive: true });
      writeFileSync(m.holdPath, JSON.stringify({
        pid: m.pgid,
        reason: m.description,
        expires_ms: m.startedAt + m.timeoutMs + 15000,
        owner: process.pid,
        id: m.id,
        command: m.command,
        agent: m.agent,
        log: m.logPath,
        started_ms: m.startedAt
      }));
    } catch {}
  }
  async function recover() {
    let sessions;
    try {
      sessions = readdirSync(HOLD_DIR);
    } catch {
      return;
    }
    for (const sessionID of sessions) {
      let files;
      try {
        files = readdirSync(`${HOLD_DIR}/${sessionID}`);
      } catch {
        continue;
      }
      for (const file of files) {
        const match = HOLD_FILE.exec(file);
        if (!match)
          continue;
        const owner = Number(match[1]);
        const cut = Boolean(match[3]);
        if (!cut && (owner === process.pid || pidAlive(owner)))
          continue;
        const from = `${HOLD_DIR}/${sessionID}/${file}`;
        const claimed = `${from}.claimed-${process.pid}`;
        try {
          renameSync(from, claimed);
        } catch {
          continue;
        }
        let hold = {};
        try {
          hold = JSON.parse(readFileSync(claimed, "utf8"));
        } catch {}
        rmSync(claimed, { force: true });
        if (cut && pidAlive(hold.pid))
          continue;
        if ((hold.expires_ms ?? 0) < Date.now() - RECOVER_MAX_AGE_MS)
          continue;
        const m = {
          id: hold.id ?? match[2],
          sessionID,
          agent: hold.agent,
          description: hold.reason ?? "monitor",
          command: hold.command ?? "(not recorded)",
          logPath: hold.log ?? `${LOG_DIR}/${sessionID}-${match[2]}.log`,
          state: "killed",
          tail: []
        };
        let tail = [];
        try {
          tail = readFileSync(m.logPath, "utf8").split(`
`).filter(Boolean).slice(-TAIL_LINES);
        } catch {}
        const armed = hold.started_ms ? ` (armed ${seconds(Date.now() - hold.started_ms)} ago)` : "";
        await send(m, `killed because the OpenCode process running it exited${armed}`, [
          "OpenCode restarted (or crashed) while this monitor was armed, and its process group died with it, so it never reported. Check the state of what it watched once now. If that is still in flight, re-arm the same monitor before you do anything else or end your turn; if it already finished, act on the result.",
          tail.length ? `last ${tail.length} lines of output before it died:` : "the command printed nothing before it died.",
          ...tail
        ]);
      }
    }
  }
  const recoverTimers = HEADLESS_RUN ? [] : [setTimeout(() => void recover(), RECOVER_DELAY_MS), setInterval(() => void recover(), RECOVER_EVERY_MS)];
  for (const timer of recoverTimers)
    timer.unref?.();
  async function finish(m, reason) {
    if (m.state !== "running")
      return m.done;
    m.state = reason;
    if (reason === "dispose") {
      try {
        renameSync(m.holdPath, m.holdPath.replace(/\.json$/, ".cut.json"));
      } catch {}
    } else
      rmSync(m.holdPath, { force: true });
    clearTimeout(m.timer);
    clearTimeout(m.flushTimer);
    clearTimeout(m.exitTimer);
    m.done = (async () => {
      const gone = await killGroup(m.pgid);
      for (const stream of ["stdout", "stderr"]) {
        if (m.partial[stream])
          onLine(m, m.partial[stream], stream);
        m.partial[stream] = "";
      }
      m.endedAt = Date.now();
      monitors.delete(m.id);
      finished.push(m);
      if (finished.length > 20)
        finished.shift();
      if (!gone)
        record(m, `monitor: process group ${m.pgid} survived SIGKILL`);
      const ran = seconds(m.endedAt - m.startedAt);
      const unreported = m.pending.splice(0);
      const body = [
        ...m.pattern && unreported.length ? [`output matching ${m.pattern}:`, ...unreported.slice(0, MAX_LINES_PER_EVENT)] : [],
        m.tail.length ? `last ${m.tail.length} lines of output:` : "the command printed nothing.",
        ...m.tail,
        ...gone ? [] : [`WARNING: process group ${m.pgid} is still alive after SIGKILL. Kill it by hand.`]
      ];
      if (reason === "exited") {
        const how = m.exit?.signal ? `was killed by ${m.exit.signal}` : `exited with code ${m.exit?.code}`;
        await send(m, `${how} after ${ran}`, body);
      } else if (reason === "timeout") {
        const hint = "If the thing it watched is still running (a long benchmark, CI, a deploy), check its state once and re-arm the same monitor now, before you do anything else or end your turn. Letting it lapse makes the session look idle while work is still in flight.";
        await send(m, `timed out after ${seconds(m.timeoutMs)}, process group killed`, [hint, ...body]);
      } else if (reason === "noisy") {
        const hint = `It produced more than ${MAX_EVENTS} notifications. Re-arm it with a narrower pattern or a quieter command.`;
        await send(m, "stopped for being too noisy", [hint, ...body]);
      } else if (reason === "aborted") {
        const hint = "The turn was interrupted, which stops this session's monitors. Re-arm it if it is still needed.";
        await send(m, "stopped because the turn was interrupted", [hint, ...body], true);
      }
      return gone;
    })();
    return m.done;
  }
  const stopSession = (sessionID, reason) => Promise.all([...monitors.values()].filter((m) => m.sessionID === sessionID).map((m) => finish(m, reason)));
  const describe = (m) => `${m.id} [${m.state}] ${m.description} (${seconds((m.endedAt ?? Date.now()) - m.startedAt)}` + `${m.state === "running" ? ` of ${seconds(m.timeoutMs)}` : ""}): ${m.command}`;
  return {
    dispose: async () => {
      for (const timer of recoverTimers)
        clearTimeout(timer);
      for (const wake of wakes.values())
        clearTimeout(wake.timer);
      await Promise.all([...monitors.values()].map((m) => finish(m, "dispose")));
    },
    event: async ({ event }) => {
      if (event.type === "session.idle")
        await checkWake(event.properties?.sessionID);
      if (event.type === "session.deleted") {
        clearTimeout(wakes.get(event.properties?.info?.id)?.timer);
        wakes.delete(event.properties?.info?.id);
        await stopSession(event.properties?.info?.id, "session-deleted");
      }
      if (KILL_ON_ABORT && event.type === "session.error" && event.properties?.error?.name === "MessageAbortedError")
        await stopSession(event.properties.sessionID, "aborted");
    },
    tool: {
      monitor: tool({
        description: [
          "Watch something in the background and get woken up when it changes. Starts a shell command, returns immediately, and later posts a notification into this session, which starts a new turn for you even if you had already finished. Use it for CI runs, PR merge state, deploys, or replies you are waiting on, instead of sleeping or polling with bash.",
          "",
          "You are notified when the command prints a line to stdout (lines within one second are batched; with `pattern`, only matching lines), when it exits (with the exit code and the last lines of output), and when it times out. After arming it, do not poll or sleep: keep working, or end your turn.",
          "",
          "Rules:",
          "- The command must be able to end itself: poll, then exit once the state is terminal, on failure as well as success. Example: `until gh pr checks 123 | grep -qE 'pass|fail'; do sleep 30; done; gh pr checks 123`. `tail -f`, `inotifywait -m`, `fswatch` and `while true` without a break or exit are refused.",
          "- If you filter with `pattern` or grep, include the failure signatures (fail|error|Traceback|Killed), or a crash looks the same as still running.",
          "- Every monitor has a timeout (default 5 minutes, at most 24 hours), after which its process group is killed and you are notified. Pick one that fits what you are waiting for.",
          "- Call monitor_stop as soon as you have your answer if the monitor is still running. Monitors also stop when a turn is interrupted or the session ends."
        ].join(`
`),
        args: {
          command: tool.schema.string().describe("Shell command to run in the background. It must end by itself."),
          description: tool.schema.string().describe("What is being watched, in a few words. Shown in notifications."),
          timeout_ms: tool.schema.number().int().min(1000).max(MAX_TIMEOUT_MS).optional().describe(`Kill the monitor after this long. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`),
          pattern: tool.schema.string().optional().describe("JavaScript regex. When set, only stdout lines that match trigger a notification. Exit and timeout always notify.")
        },
        async execute(args, ctx) {
          let pattern;
          if (args.pattern) {
            try {
              pattern = new RegExp(args.pattern);
            } catch (error) {
              throw new Error(`Invalid pattern: ${error.message}`);
            }
          }
          if (HEADLESS_RUN)
            throw new Error("Refused: this session runs as a headless `opencode run`, which exits when your turn ends and kills any monitor with it, so no notification would ever arrive. Wait in the foreground instead: a bash call with an `until <check>; do sleep 30; done` loop (bash calls time out, so keep each wait under its limit and loop again), then act on the result before ending your turn.");
          const session = await client.session.get({ path: { id: ctx.sessionID } });
          if (session.data?.parentID)
            throw new Error("Refused: monitors cannot be armed from a subagent, because the notification would arrive after the subagent has returned. Arm it from the primary session.");
          const mine = [...monitors.values()].filter((m) => m.sessionID === ctx.sessionID);
          if (mine.length >= MAX_PER_SESSION)
            throw new Error(`Refused: this session already has ${mine.length} monitors running. Stop one first:
${mine.map(describe).join(`
`)}`);
          const warnings = guard(args.command, args.description, ctx.directory, ctx.sessionID);
          const timeoutMs = args.timeout_ms ?? DEFAULT_TIMEOUT_MS;
          const child = spawn(process.env.SHELL || "/bin/sh", ["-c", args.command], {
            cwd: ctx.directory,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, CLAUDE_CODE_SESSION_ID: ctx.sessionID }
          });
          if (!child.pid)
            throw new Error("Failed to start the monitor command.");
          const id = `m${++counter}`;
          const m = {
            id,
            sessionID: ctx.sessionID,
            agent: ctx.agent,
            description: args.description,
            command: args.command,
            pattern,
            timeoutMs,
            pgid: child.pid,
            startedAt: Date.now(),
            state: "running",
            events: 0,
            pending: [],
            tail: [],
            partial: { stdout: "", stderr: "" },
            logPath: `${LOG_DIR}/${ctx.sessionID}-${id}.log`,
            holdPath: `${HOLD_DIR}/${ctx.sessionID}/${process.pid}-${id}.json`
          };
          monitors.set(id, m);
          writeHold(m);
          spawn("/bin/sh", ["-c", WATCHDOG, "monitor-watchdog", String(process.pid), String(m.pgid), String(Math.ceil(timeoutMs / 1000) + 15)], { detached: true, stdio: "ignore" }).unref();
          for (const stream of ["stdout", "stderr"]) {
            child[stream].setEncoding("utf8");
            child[stream].on("data", (chunk) => {
              const lines = (m.partial[stream] + chunk).split(`
`);
              m.partial[stream] = lines.pop();
              for (const line of lines)
                onLine(m, line, stream);
            });
          }
          child.on("error", (error) => {
            record(m, `monitor: ${error.message}`);
            m.exit ??= { code: null, signal: null };
            finish(m, "exited");
          });
          child.on("exit", (code, signal) => {
            m.exit = { code, signal };
            m.exitTimer = setTimeout(() => void finish(m, "exited"), 500);
          });
          child.on("close", () => void finish(m, "exited"));
          m.timer = setTimeout(() => void finish(m, "timeout"), timeoutMs);
          return [
            `Monitor ${id} armed: ${args.description} (process group ${m.pgid}, timeout ${seconds(timeoutMs)}).`,
            "You will be notified in this session when it " + (pattern ? `prints a line matching ${pattern}` : "prints to stdout") + ", exits, or times out. Do not poll or sleep: keep working or end your turn.",
            `Stop it with monitor_stop (id ${id}).`,
            ...warnings.map((warning) => `Warning: ${warning}`)
          ].join(`
`);
        }
      }),
      monitor_stop: tool({
        description: "Stop monitors armed with `monitor` and kill their process groups. Pass an id to stop one, or omit it to stop every monitor in this session. Stopping does not send a notification. Call it once you have your answer, and before you finish if anything is still armed.",
        args: {
          id: tool.schema.string().optional().describe("Monitor id, e.g. m1. Omit to stop all monitors in this session.")
        },
        async execute(args, ctx) {
          const mine = [...monitors.values()].filter((m) => m.sessionID === ctx.sessionID);
          const targets = args.id ? mine.filter((m) => m.id === args.id) : mine;
          if (targets.length === 0) {
            const ended = finished.find((m) => m.sessionID === ctx.sessionID && m.id === args.id);
            if (ended)
              return `Monitor ${ended.id} had already ended (${ended.state}). Nothing to stop.`;
            return args.id ? `No monitor ${args.id} is running in this session. Running: ${mine.map((m) => m.id).join(", ") || "none"}.` : "No monitors are running in this session.";
          }
          const results = [];
          for (const m of targets) {
            const gone = await finish(m, "stopped");
            results.push(`Stopped ${m.id} (${m.description}) after ${seconds(m.endedAt - m.startedAt)}; process group ${m.pgid} ` + (gone ? "is gone." : "IS STILL ALIVE after SIGKILL, kill it by hand.") + (m.tail.length ? `
last output:
${m.tail.join(`
`)}` : ""));
          }
          return results.join(`

`);
        }
      }),
      monitor_list: tool({
        description: "List this session's monitors: the ones still running and the ones that ended recently. Use it before finishing to check nothing is left armed.",
        args: {},
        async execute(_args, ctx) {
          const mine = [...monitors.values(), ...finished].filter((m) => m.sessionID === ctx.sessionID);
          return mine.length ? mine.map(describe).join(`
`) : "No monitors in this session.";
        }
      })
    }
  };
};
export {
  Monitor
};

//# debugId=45BCBA436745141F64756E2164756E21
