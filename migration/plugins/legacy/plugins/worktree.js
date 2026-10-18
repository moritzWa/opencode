// @bun
// ../../../../../../../.config/opencode/plugins/worktree.js
import { tool } from "@opencode-ai/plugin";
import { spawnSync } from "child_process";
import { appendFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
var NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim(), err: (result.stderr ?? "").trim() };
}
function mainRoot(cwd) {
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok)
    throw new Error(`not a git repository: ${cwd}`);
  return common.out.replace(/\/\.git$/, "");
}
function ignoreWorktrees(root) {
  if (git(root, ["check-ignore", "-q", ".claude/worktrees/x"]).ok)
    return;
  const exclude = join(root, ".git", "info", "exclude");
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  appendFileSync(exclude, `${current && !current.endsWith(`
`) ? `
` : ""}/.claude/worktrees/
`);
}
function worktrees(root) {
  const list = git(root, ["worktree", "list", "--porcelain"]);
  if (!list.ok)
    return [];
  return list.out.split(`

`).map((block) => {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    return path ? { path, branch } : undefined;
  }).filter((entry) => entry && entry.path.includes("/.claude/worktrees/"));
}
var WorktreePlugin = async () => ({
  tool: {
    worktree_create: tool({
      description: "Create a git worktree: a separate checkout of this repo on its own branch, so parallel or risky work does not touch the main working tree. Returns its absolute path. Work in it by using that path as the workdir for shell commands and in file paths. Only use one when isolation actually helps; ordinary edits belong in the current checkout.",
      args: {
        name: tool.schema.string().describe("Short kebab-case name, e.g. fix-login. Also the branch name."),
        base: tool.schema.string().optional().describe("Branch or commit to start from. Defaults to the current HEAD.")
      },
      async execute(args, ctx) {
        if (!NAME.test(args.name))
          return `Invalid name "${args.name}": use letters, digits, ".", "_" or "-".`;
        const root = mainRoot(ctx.directory);
        const path = join(root, ".claude", "worktrees", args.name);
        if (existsSync(path))
          return `Worktree already exists: ${path}`;
        ignoreWorktrees(root);
        const branchExists = git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${args.name}`]).ok;
        const add = branchExists ? git(root, ["worktree", "add", path, args.name]) : git(root, ["worktree", "add", "-b", args.name, path, ...args.base ? [args.base] : []]);
        if (!add.ok)
          return `git worktree add failed: ${add.err}`;
        return `Created worktree ${path} on branch ${args.name}${branchExists ? " (existing branch)" : ""}. Dependencies such as node_modules are not copied; install them there if needed.`;
      }
    }),
    worktree_list: tool({
      description: "List this repo's worktrees under .claude/worktrees, with their branch and whether they have uncommitted changes.",
      args: {},
      async execute(_args, ctx) {
        const entries = worktrees(mainRoot(ctx.directory));
        if (!entries.length)
          return "No worktrees.";
        return entries.map((entry) => {
          const dirty = git(entry.path, ["status", "--porcelain"]).out ? "uncommitted changes" : "clean";
          return `${entry.path} [${entry.branch ?? "detached"}] ${dirty}`;
        }).join(`
`);
      }
    }),
    worktree_remove: tool({
      description: "Remove a worktree created with worktree_create. Refuses when it has uncommitted changes unless force is set. Deletes its branch only when that branch is fully merged, so unmerged commits are never lost.",
      args: {
        name: tool.schema.string().describe("The worktree name passed to worktree_create."),
        force: tool.schema.boolean().optional().describe("Discard uncommitted changes in the worktree.")
      },
      async execute(args, ctx) {
        if (!NAME.test(args.name))
          return `Invalid name "${args.name}".`;
        const root = mainRoot(ctx.directory);
        const entry = worktrees(root).find((item) => item.path === join(root, ".claude", "worktrees", args.name));
        if (!entry)
          return `No worktree named ${args.name}.`;
        if (!args.force && git(entry.path, ["status", "--porcelain"]).out)
          return `${entry.path} has uncommitted changes. Commit them, or pass force to discard them.`;
        const remove = git(root, ["worktree", "remove", ...args.force ? ["--force"] : [], entry.path]);
        if (!remove.ok)
          return `git worktree remove failed: ${remove.err}`;
        if (!entry.branch)
          return `Removed ${entry.path}.`;
        const branch = git(root, ["branch", "-d", entry.branch]);
        return branch.ok ? `Removed ${entry.path} and its merged branch ${entry.branch}.` : `Removed ${entry.path}. Kept branch ${entry.branch} because it has unmerged commits.`;
      }
    })
  }
});
export {
  WorktreePlugin
};

//# debugId=5A8288F5CF36467564756E2164756E21
