// Item 95, slice 1b (decision 95 (a)): the delivery evidence the hooks keep so the agent records a delivery check after
// this session's merge and deploy. Plain Node ESM, no build, no dependencies. session-start.mjs enters the binding and
// takes the baseline; post-tool-use.mjs records a shell call's merge command and prints the delivery-check context once.
//
// A binding is { root, repo, workspace, project }: root is the linked folder (findLink's root, resolved), repo the
// normalised GitHub origin "github.com/<owner>/<repo>", workspace and project from .handsoff.json.
// Each session keeps one active-binding record, <data>/deliveries/active/<session>.json, holding { binding, generation }.
// The evidence of the active generation lives in <data>/deliveries/<sha256 of session|generation|root|repo|workspace|project>.json,
// holding { binding, generation, head, tags, merges, offered }: head and tags (the tag names) are the generation's
// baseline; merges and offered are arrays of PR numbers. Every read, change and write of either file holds the lock
// `mkdir <file>.lock` (up to 2 s, then skip; a lock older than 10 s is stale and taken over); writes go through a
// temporary file and a rename.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { findLink, runGit } from "./lib.mjs";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const SHELL_TOOLS = new Set(["Bash", "shell", "exec_command"]);

// --- the merge command ---------------------------------------------------------------------------------------------

/**
 * Whether a shell response is no finished success: an error, a non-zero exit code, or a command that hasn't finished
 * (still running in the background: backgroundTaskId or background_task_id, even with exit code 0; or interrupted).
 * A finished response with no exit code counts as a success (PR 183 r5).
 */
const failed = (r) =>
  isObject(r) &&
  (r.isError === true || r.is_error === true || r.interrupted === true ||
    (r.backgroundTaskId !== undefined && r.backgroundTaskId !== null) ||
    (r.background_task_id !== undefined && r.background_task_id !== null) ||
    (r.exit_code !== undefined && r.exit_code !== null && r.exit_code !== 0) ||
    (r.exitCode !== undefined && r.exitCode !== null && r.exitCode !== 0));

/**
 * "github.com/<owner>/<repo>" (lower case, no .git) for a -R/--repo value `github.com/owner/repo` (the host in any case);
 * else null. A hostless `owner/repo` is null: gh resolves it through GH_HOST, which may name another host (PR 183 r4).
 */
const repoTarget = (value) => {
  if (!/^github\.com\//i.test(value)) return null;
  const parts = value.slice("github.com/".length).replace(/\.git$/i, "").split("/");
  if (parts.length !== 2 || !parts.every((p) => /^[A-Za-z0-9._-]+$/.test(p) && p !== "." && p !== "..")) return null;
  return `github.com/${parts[0]}/${parts[1]}`.toLowerCase();
};

const PR_NUMBER = /^[1-9][0-9]*$/;
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/([1-9][0-9]*)$/i;
const METHOD_FLAGS = new Set(["-s", "--squash", "-m", "--merge", "-r", "--rebase", "-d", "--delete-branch"]);

/**
 * The PR number of one command's words when they are `gh pr merge <n | PR URL>` naming `repo` (PR 183 scope), or null.
 * After the number or URL, in any order: one `-R X`, `--repo X` or `--repo=X`, and the method flags -s/--squash,
 * -m/--merge, -r/--rebase and -d/--delete-branch. Anything else is null: an X=y prefix, another flag or value, a flag
 * before the number, gh flags before `pr`, two -R, a URL not exactly https://github.com/<owner>/<repo>/pull/<n>, -R and a
 * URL naming different repositories, or no -R and no URL (a plain merge names no target).
 */
const namedMerge = (words, repo) => {
  if (words.length < 4 || words[0] !== "gh" || words[1] !== "pr" || words[2] !== "merge") return null;
  const targets = [];
  let n;
  const pr = words[3];
  if (PR_NUMBER.test(pr)) n = Number(pr);
  else {
    const m = PR_URL.exec(pr);
    if (!m) return null;
    const t = repoTarget(`github.com/${m[1]}/${m[2]}`);
    if (!t) return null;
    targets.push(t);
    n = Number(m[3]);
  }
  if (!Number.isSafeInteger(n)) return null;
  let named = false;
  for (let i = 4; i < words.length; i++) {
    const w = words[i];
    if (METHOD_FLAGS.has(w)) continue;
    let value;
    if (w === "-R" || w === "--repo") {
      if (i + 1 >= words.length) return null;
      value = words[++i];
    } else if (w.startsWith("--repo=")) value = w.slice("--repo=".length);
    else return null;
    if (named) return null;
    named = true;
    const t = repoTarget(value);
    if (!t) return null;
    targets.push(t);
  }
  if (!targets.length || !targets.every((t) => t === String(repo).toLowerCase())) return null;
  return n;
};

// The merge command's own shell parse (lib.mjs's parseShell, used for commit detection, drops the connectors). It reads
// a script only as simple commands joined by `&&`, so a merge in it must have run, here, and succeeded. Anything else it
// can't read with confidence is no script: `;`, a newline, `||`, `|`, a background `&`, `(`, `)`, `$(`, backticks, `{`,
// `}`, `!`, a comment, a heredoc or a here-string, `<(`/`>(`, an unclosed quote, an empty command. Redirections (`>f`,
// `2>&1`, `&>/dev/null`, `<f`, `>>f`) are read and dropped.

const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "select", "function", "time", "coproc", "[[", "]]"]);
const MOVES_DIR = new Set(["cd", "pushd", "popd"]);
// Words that run (or change how the shell runs) another command, which may move the directory or the environment:
// `command cd X`, `eval 'cd X'`, `. ./env`. One before the merge (or on it) makes the call no merge.
const WRAPPERS = new Set(["command", "builtin", "exec", "eval", "source", ".", "env", "sudo", "xargs", "nohup", "time", "nice", "doas"]);
// Commands that change the shell's own variables (GH_HOST, GH_REPO, ...) for what follows: one anywhere in the chain, or
// a command made only of X=y assignments, makes the call no merge (PR 183 review r4).
const SETS_ENV = new Set(["export", "declare", "typeset", "readonly", "set", "unset"]);

/** Whether the hook's own environment may send gh elsewhere: GH_HOST not github.com (any case), or GH_REPO set. */
const ghEnvElsewhere = (env) => {
  if (!isObject(env)) return false;
  const host = typeof env.GH_HOST === "string" ? env.GH_HOST : "";
  const repo = typeof env.GH_REPO === "string" ? env.GH_REPO : "";
  return (host !== "" && host.toLowerCase() !== "github.com") || repo !== "";
};

/** A script's simple commands (arrays of words) when it is only commands joined by `&&`; null otherwise. */
const andChain = (script) => {
  const commands = [];
  let words = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (!words.length) return false;
    commands.push(words);
    words = [];
    return true;
  };
  const s = script.replace(/\s+$/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      const close = s.indexOf("'", i + 1);
      if (close === -1) return null;
      word += s.slice(i + 1, close);
      inWord = true;
      i = close;
    } else if (c === '"') {
      inWord = true;
      let closed = false;
      for (i += 1; i < s.length; i++) {
        const d = s[i];
        if (d === '"') {
          closed = true;
          break;
        }
        if (d === "`" || (d === "$" && s[i + 1] === "(")) return null;
        if (d === "\\" && i + 1 < s.length) {
          i++;
          if (s[i] === "\n") continue;
          if (!'$`"\\'.includes(s[i])) word += "\\";
        }
        word += s[i];
      }
      if (!closed) return null;
    } else if (c === "\\") {
      if (i + 1 >= s.length) return null;
      i++;
      if (s[i] !== "\n") {
        word += s[i];
        inWord = true;
      }
    } else if (c === " " || c === "\t" || c === "\r") {
      endWord();
    } else if (c === "&" && s[i + 1] === "&") {
      if (!endCommand()) return null;
      i++;
    } else if (c === ">" || c === "<" || (c === "&" && s[i + 1] === ">")) {
      // A redirection: an optional fd number (the word so far, all digits), the operator, then its target.
      if (inWord && !/^[0-9]+$/.test(word)) return null;
      word = "";
      inWord = false;
      let j = i;
      if (s[j] === "&") j++;
      const op = s[j];
      j++;
      if (op === "<" && (s[j] === "<" || s[j] === "(" || s[j] === ">")) return null; // heredoc, here-string, <(, <>
      if (op === ">" && (s[j] === "(" || s[j] === "|")) return null; // >( and >|
      if (op === ">" && s[j] === ">") j++;
      if (s[j] === "&" && s[i] !== "&") {
        // >&2, 2>&1, >&- : the target is an fd number or -
        const m = /^(?:[0-9]+|-)/.exec(s.slice(j + 1));
        if (!m) return null;
        i = j + m[0].length;
      } else {
        while (s[j] === " " || s[j] === "\t") j++;
        const m = /^[A-Za-z0-9_./:@%+=,~-]+/.exec(s.slice(j));
        if (!m) return null; // a quoted, expanded or missing target: not read
        i = j + m[0].length - 1;
      }
      if (i + 1 < s.length && !" \t\r&".includes(s[i + 1])) return null;
    } else if ("&|;\n()`{}".includes(c) || (c === "$" && s[i + 1] === "(")) {
      return null;
    } else if ((c === "#" || c === "!") && !inWord) {
      return null;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (!endCommand()) return null;
  return commands;
};

/** A command's words without its FOO=bar prefixes. */
const commandWords = (words) => {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
  return words.slice(i);
};

/** Whether the shell call ran in the binding's link root (or inside it); a call without a cwd is taken as run there. */
const ranInRoot = (input, binding) => {
  if (!("cwd" in input) || input.cwd === undefined) return true;
  if (typeof input.cwd !== "string" || !input.cwd || !isBinding(binding)) return false;
  const cwd = resolve(input.cwd);
  const root = resolve(binding.root);
  return cwd === root || cwd.startsWith(root.endsWith("/") ? root : `${root}/`);
};

/** A path made canonical (symlinks resolved) when it exists, else only resolved. */
const canonical = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/**
 * Whether the git repository nearest the call's cwd (or the link root, without a cwd) is the link root's own: the nearest
 * `.git` (a directory or a `gitdir:` file) resolved through commondir, compared with the link root's. Never spawns git.
 */
const sameRepository = (input, binding) => {
  if (!isBinding(binding)) return false;
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : binding.root;
  const here = commonGitDir(cwd);
  const bound = commonGitDir(binding.root);
  return here !== null && bound !== null && canonical(here) === canonical(bound);
};

// --- slice 1c: merges that name no target ----------------------------------------------------------------------------

const PR_WORD = "{pr}";
const PR_SLOT = "\u0000pr\u0000";

/**
 * The words of each valid `mergeCommands` entry in `<root>/.handsoff.json`, read on each call. An entry is a string that
 * parses as one simple command with exactly one whole word `{pr}` (and `{pr}` in no other word), not starting with gh,
 * an X=y prefix, a wrapper, a directory move, a keyword or an environment command. A bad entry is skipped.
 */
const mergeCommandEntries = (root) => {
  const link = readJson(join(root, ".handsoff.json"));
  if (!isObject(link) || !Array.isArray(link.mergeCommands)) return [];
  const entries = [];
  for (const entry of link.mergeCommands) {
    if (typeof entry !== "string" || entry.includes(PR_SLOT)) continue;
    // The shell parse refuses braces, so `{pr}` stands in as a slot no command can spell.
    const commands = andChain(entry.split(PR_WORD).join(PR_SLOT));
    if (!commands || commands.length !== 1) continue;
    const words = commands[0];
    const first = words[0];
    if (first === "gh" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(first) || WRAPPERS.has(basename(first)) || MOVES_DIR.has(first) || KEYWORDS.has(first) || SETS_ENV.has(first)) continue;
    if (words.filter((w) => w === PR_SLOT).length !== 1 || words.some((w) => w !== PR_SLOT && w.includes(PR_SLOT))) continue;
    entries.push(words);
  }
  return entries;
};

/** Whether the call ran in the link root itself (no cwd counts as the link root). */
const ranAtRoot = (input, binding) =>
  !("cwd" in input) || input.cwd === undefined || (typeof input.cwd === "string" && resolve(input.cwd) === resolve(binding.root));

/**
 * The PR number of a lone command that is `shipcraft merge <n>` (exactly those words) or, run in the link root itself,
 * matches a listed `mergeCommands` entry word for word with a PR number in place of `{pr}`; else null.
 */
const unnamedMerge = (words, input, binding) => {
  if (words.length === 3 && words[0] === "shipcraft" && words[1] === "merge" && PR_NUMBER.test(words[2])) {
    const n = Number(words[2]);
    return Number.isSafeInteger(n) ? n : null;
  }
  if (!ranAtRoot(input, binding)) return null;
  for (const entry of mergeCommandEntries(binding.root)) {
    if (entry.length !== words.length) continue;
    let n = null;
    const same = entry.every((w, i) => {
      if (w !== PR_SLOT) return w === words[i];
      if (!PR_NUMBER.test(words[i])) return false;
      n = Number(words[i]);
      return Number.isSafeInteger(n);
    });
    if (same && n !== null) return n;
  }
  return null;
};

const GIT_LOCATION_ENV = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]);

/** Whether the hook's environment may move git elsewhere: GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR or any GIT_CONFIG*. */
const gitEnvMoved = (env) =>
  isObject(env) && Object.keys(env).some((k) => env[k] !== undefined && (GIT_LOCATION_ENV.has(k) || k.startsWith("GIT_CONFIG")));

/**
 * The single-remote target proof of a merge that names no target, read by git after the call in the call's directory:
 * `git remote` prints only origin, origin's url as git resolves it (insteadOf, includes) is `binding.repo`, and
 * `remote.origin.gh-resolved` is unset, empty or `base`; with no git location or config variable in `env`. Anything in
 * doubt (git failing included) is no proof.
 */
const unnamedTargetProof = (input, binding, env) => {
  if (gitEnvMoved(env)) return false;
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : binding.root;
  try {
    const remotes = runGit(cwd, ["remote"]).split("\n").map((l) => l.trim()).filter(Boolean);
    if (remotes.length !== 1 || remotes[0] !== "origin") return false;
    const urls = runGit(cwd, ["remote", "get-url", "--all", "origin"]).split("\n").map((l) => l.trim()).filter(Boolean);
    if (urls.length !== 1 || githubRepo(urls[0]) !== binding.repo) return false;
    let resolved = [];
    try {
      resolved = runGit(cwd, ["config", "--get-all", "remote.origin.gh-resolved"]).split("\n").filter((l, i, a) => l !== "" || i < a.length - 1);
    } catch (e) {
      if (e?.status !== 1) return false; // 1: unset
    }
    return resolved.every((v) => v === "" || v === "base");
  } catch {
    return false;
  }
};

/**
 * The PR number a successful shell tool call merged with `gh pr merge <n>` naming the evidence repository, or null (slice
 * 1b, PR 183 scope): the merge must name its target with -R/--repo/--repo= <owner/repo> or the PR URL
 * https://github.com/<owner>/<repo>/pull/<n>, normalised (lower case, no .git, an optional github.com/ prefix) equal to
 * `binding.repo`, -R and a URL agreeing, with only the method flags and --delete-branch besides (namedMerge); a plain
 * `gh pr merge <n>` names no target and is null, whatever gh-resolved says (an explicit -R wins over gh's default). The
 * script must be simple commands joined by `&&` only (so the merge ran and succeeded), with no cd, pushd, popd or command
 * wrapper (command, builtin, exec, eval, source, ., env, sudo, ...) before or on the merge and no control keyword, no
 * X=y prefix on the merge itself (one on an earlier command is fine), and the call's cwd in the link root and in the
 * link root's own git repository (not a nested clone or a submodule). PR 183 r4: the -R value names its host
 * (github.com/<owner>/<repo>); a chain holding export, declare, typeset, readonly, set, unset or a command of assignments
 * only is null; so is every merge when `env` (the hook's environment, passed in by the hook) has GH_HOST other than
 * github.com or GH_REPO set. `input` is a PostToolUse hook input; `binding` the evidence binding.
 * Slice 1c: a call that is only `shipcraft merge <n>` (in the link root or a subfolder) or a listed `mergeCommands` entry
 * (in the link root itself) also counts, under the single-remote target proof (unnamedTargetProof).
 */
export function mergeCommand(input, binding, env = {}) {
  if (!isObject(input) || !SHELL_TOOLS.has(input.tool_name) || failed(input.tool_response)) return null;
  // A call run in the background hasn't finished when the hook runs: it is no merge (PR 183 r5).
  if (isObject(input.tool_input) && input.tool_input.run_in_background === true) return null;
  if (ghEnvElsewhere(env)) return null;
  const command = isObject(input.tool_input) ? input.tool_input.command : undefined;
  if (typeof command !== "string") return null;
  if (!ranInRoot(input, binding) || !sameRepository(input, binding)) return null;
  const commands = andChain(command);
  if (!commands) return null;
  // Slice 1c: a merge that names no target (`shipcraft merge <n>`, a listed mergeCommands entry) is the whole call.
  // A lone command that isn't gh is never a named merge, so it is settled here. Git runs only once the words parse.
  if (commands.length === 1 && commands[0][0] !== "gh") {
    const n = unnamedMerge(commands[0], input, binding);
    return n !== null && unnamedTargetProof(input, binding, env) ? n : null;
  }
  if (commands.some((words) => { const w = commandWords(words); return !w.length || KEYWORDS.has(w[0]) || SETS_ENV.has(w[0]); })) return null;
  for (const words of commands) {
    const w = commandWords(words);
    if (w.length && (MOVES_DIR.has(w[0]) || WRAPPERS.has(basename(w[0])))) return null;
    if (w[0] !== "gh" || w[1] !== "pr" || w[2] !== "merge") continue;
    // A merge command: with a prefix, or not naming this repository, the call is no merge.
    if (w.length !== words.length) return null;
    return namedMerge(words, binding.repo);
  }
  return null;
}

// --- the binding ----------------------------------------------------------------------------------------------------

const readText = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};
const isDir = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The common git directory (the one holding config) of the repository holding `dir`, read without spawning git. */
const commonGitDir = (dir) => {
  let current = resolve(dir);
  for (;;) {
    const dotGit = join(current, ".git");
    let gitDir;
    if (isDir(dotGit)) gitDir = dotGit;
    else {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit) ?? "");
      if (m) gitDir = resolve(current, m[1]);
    }
    if (gitDir) {
      const common = readText(join(gitDir, "commondir"));
      return common && common.trim() ? resolve(gitDir, common.trim()) : gitDir;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

/** The url of remote "origin" in a git config file's text, or null. */
const originUrl = (config) => {
  let inOrigin = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
    if (section) {
      inOrigin = section[1].toLowerCase() === "remote" && section[2] === "origin";
      continue;
    }
    if (!inOrigin) continue;
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(line);
    if (!kv || kv[1].toLowerCase() !== "url") continue;
    let value = kv[2].trim();
    if (value.startsWith('"')) {
      const close = value.indexOf('"', 1);
      value = value.slice(1, close === -1 ? undefined : close);
    } else value = value.replace(/\s[#;].*$/, "").trim();
    return value || null;
  }
  return null;
};

/** "github.com/<owner>/<repo>" (lower case, no .git) for a GitHub remote URL, HTTPS or SSH; null for anything else. */
const githubRepo = (url) => {
  let host;
  let path;
  const full = /^(?:https?|ssh|git|git\+ssh|ssh\+git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d*)?\/(.*)$/i.exec(url);
  if (full) [, host, path] = full;
  else {
    if (url.includes("://")) return null;
    const scp = /^(?:[^@/:]+@)?([^/:]+):(.*)$/.exec(url);
    if (!scp) return null;
    [, host, path] = scp;
  }
  if (host.toLowerCase() !== "github.com") return null;
  const parts = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "").split("/");
  if (parts.length !== 2 || !parts.every((p) => /^[A-Za-z0-9._-]+$/.test(p) && p !== "." && p !== "..")) return null;
  return `github.com/${parts[0]}/${parts[1]}`.toLowerCase();
};

/** The evidence binding of the linked folder holding `dir`, or null without a link, a git origin, or a GitHub origin. */
export function evidenceBinding(dir) {
  const link = findLink(dir);
  if (!link) return null;
  const gitDir = commonGitDir(link.root);
  if (!gitDir) return null;
  const url = originUrl(readText(join(gitDir, "config")) ?? "");
  const repo = url ? githubRepo(url) : null;
  if (!repo) return null;
  return { root: link.root, repo, workspace: link.workspace, project: link.project };
}

// --- git: the baseline, the merge commit and the deploy tag ---------------------------------------------------------

const tagNames = (out) => out.split("\n").filter((r) => r.startsWith("refs/tags/")).map((r) => r.slice("refs/tags/".length));

/** The baseline of a generation in the git repository at `root`: { head, tags } (HEAD's sha or null; the tag names). */
export function deliveryBaseline(root) {
  let tags;
  try {
    tags = tagNames(runGit(root, ["for-each-ref", "--format=%(refname)", "refs/tags"]));
  } catch {
    return null;
  }
  let head = null;
  try {
    head = runGit(root, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]).trim() || null;
  } catch {
    head = null;
  }
  return { head, tags };
}

const SHA = /^[0-9a-f]{40,64}$/;

/** The sha of PR `pr`'s merge commit: reachable from HEAD, not from baseline.head, subject ending "(#<pr>)"; or null. */
export function findMergeCommit(root, pr, baseline) {
  if (!Number.isSafeInteger(pr) || pr <= 0 || !isObject(baseline)) return null;
  const base = typeof baseline.head === "string" && SHA.test(baseline.head) ? baseline.head : null;
  let out;
  try {
    out = runGit(root, ["log", "--format=%H%x00%s", "HEAD", ...(base ? ["--not", base] : []), "--"]);
  } catch {
    return null;
  }
  // A squash or rebase subject ending "(#n)", or a merge commit's "Merge pull request #n from …" (slice 1c).
  const squash = new RegExp(`\\(#${pr}\\)\\s*$`);
  const mergeCommit = new RegExp(`^Merge pull request #${pr} `);
  for (const line of out.split("\n")) {
    const at = line.indexOf("\0");
    if (at <= 0) continue;
    const subject = line.slice(at + 1);
    if (squash.test(subject) || mergeCommit.test(subject)) return line.slice(0, at);
  }
  return null;
}

const DEFAULT_DEPLOY_TAGS = ["deploy-"];

/**
 * The deploy-tag prefixes of `<root>/.handsoff.json` `deployTags`: an array of one or more `<non-empty prefix>*`
 * patterns (`*` only at the end) replaces `deploy-*`; anything else, or any bad entry, falls back to `deploy-*`.
 */
const deployTagPrefixes = (root) => {
  const link = readJson(join(root, ".handsoff.json"));
  const tags = isObject(link) ? link.deployTags : undefined;
  if (!Array.isArray(tags) || !tags.length) return DEFAULT_DEPLOY_TAGS;
  if (!tags.every((t) => typeof t === "string" && /^[^*]+\*$/.test(t))) return DEFAULT_DEPLOY_TAGS;
  return tags.map((t) => t.slice(0, -1));
};

/**
 * The deploy tag of merge commit `sha`: absent from baseline.tags, matching the deploy-tag patterns (deployTags, else
 * deploy-*), containing sha; the oldest by creatordate, ties by name; or null.
 */
export function findDeployTag(root, sha, baseline) {
  if (typeof sha !== "string" || !SHA.test(sha) || !isObject(baseline) || !Array.isArray(baseline.tags)) return null;
  const known = new Set(baseline.tags);
  const prefixes = deployTagPrefixes(root);
  let out;
  try {
    out = runGit(root, ["for-each-ref", "--format=%(creatordate:unix)%00%(refname)", "--contains", sha, "refs/tags"]);
  } catch {
    return null;
  }
  const tags = [];
  for (const line of out.split("\n")) {
    const at = line.indexOf("\0");
    if (at < 0 || !line.startsWith("refs/tags/", at + 1)) continue;
    const name = line.slice(at + 1 + "refs/tags/".length);
    const date = Number(line.slice(0, at));
    if (known.has(name) || !prefixes.some((p) => name.startsWith(p))) continue;
    tags.push({ name, date: Number.isFinite(date) ? date : Infinity });
  }
  tags.sort((a, b) => a.date - b.date || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return tags[0]?.name ?? null;
}

/** The additionalContext that asks the agent to record the delivery check of PR `pr`. */
export function deliveryContext({ binding, pr, sha, tag }) {
  return [
    `This session merged PR #${pr} (https://${binding.repo}/pull/${pr}) as ${String(sha).slice(0, 7)}, and the deploy tag ${tag} contains it.`,
    `Record the delivery check in Hands-off project ${binding.workspace}/${binding.project} now: hands-off-capture, 'Delivery check'.`,
  ].join(" ");
}

// --- locked, atomic state -------------------------------------------------------------------------------------------

const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10000;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Runs `fn` holding `mkdir <file>.lock`: { ok: true, value } or, when the lock can't be taken in 2 s, { ok: false }. */
export const withLock = (file, fn) => {
  const lock = `${file}.lock`;
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch {
    return { ok: false };
  }
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if (e?.code !== "EEXIST") return { ok: false };
    }
    let age;
    try {
      age = Date.now() - statSync(lock).mtimeMs;
    } catch {
      continue; // released meanwhile
    }
    if (age > LOCK_STALE_MS) {
      // Stale: move it aside (only one taker's rename succeeds), remove it, and try again.
      const aside = `${lock}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
      try {
        renameSync(lock, aside);
        rmSync(aside, { recursive: true, force: true });
      } catch {
        // another hook took it over first
      }
      continue;
    }
    if (Date.now() >= deadline) return { ok: false };
    sleepSync(25);
  }
  try {
    return { ok: true, value: fn() };
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
};

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

/** Writes `value` to `file` through a temporary file (not *.json) and a rename. */
export const writeAtomic = (file, value) => {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing to clean
    }
    throw e;
  }
};

const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "_");
const activeFile = (dir, sessionId) => join(dir, "deliveries", "active", `${safeName(sessionId)}.json`);
const evidenceFile = (dir, sessionId, generation, b) =>
  join(dir, "deliveries", `${createHash("sha256").update([sessionId, generation, b.root, b.repo, b.workspace, b.project].join("|")).digest("hex")}.json`);

const BINDING_KEYS = ["root", "repo", "workspace", "project"];
const isBinding = (b) => isObject(b) && BINDING_KEYS.every((k) => typeof b[k] === "string" && b[k]);
const pickBinding = (b) => Object.fromEntries(BINDING_KEYS.map((k) => [k, b[k]]));
const sameBinding = (a, b) => isBinding(a) && isBinding(b) && BINDING_KEYS.every((k) => a[k] === b[k]);
const isGeneration = (g) => Number.isSafeInteger(g) && g > 0;

const readActive = (file) => {
  const v = readJson(file);
  return isObject(v) && isBinding(v.binding) && isGeneration(v.generation) ? { binding: pickBinding(v.binding), generation: v.generation } : null;
};

/** The generation the active record in `file` last named, also once cleared (leaveBinding keeps it); 0 without one. */
const lastGeneration = (file) => {
  const v = readJson(file);
  return isObject(v) && isGeneration(v.generation) ? v.generation : 0;
};

const numbers = (v) => (Array.isArray(v) ? v.filter((n) => Number.isSafeInteger(n)) : []);

/** The evidence in `file` when it belongs to `active` (binding and generation), else fresh evidence with no baseline. */
const readEvidence = (file, active) => {
  const v = readJson(file);
  if (!isObject(v) || !sameBinding(v.binding, active.binding) || v.generation !== active.generation) {
    return { binding: active.binding, generation: active.generation, merges: [], offered: [] };
  }
  return { ...v, binding: active.binding, generation: active.generation, merges: numbers(v.merges), offered: numbers(v.offered) };
};

/** The session's active-binding record { binding, generation }, or null when it has none (or its lock can't be taken). */
export function activeBinding(dir, sessionId) {
  const file = activeFile(dir, sessionId);
  const r = withLock(file, () => readActive(file));
  return r.ok ? r.value : null;
}

/**
 * Makes `binding` the session's active one, under the active record's lock. The same binding keeps its generation and
 * baseline; a different one (or none before) increments the generation and starts fresh evidence with the baseline
 * `takeBaseline()` returns (called only then). Returns { binding, generation }, or null when the lock can't be taken.
 */
export function enterBinding(dir, sessionId, binding, takeBaseline) {
  if (!isBinding(binding)) return null;
  const file = activeFile(dir, sessionId);
  try {
    const r = withLock(file, () => {
      const current = readActive(file);
      if (current && sameBinding(current.binding, binding)) return current;
      return startGeneration(dir, sessionId, file, binding, takeBaseline);
    });
    return r.ok ? r.value : null;
  } catch {
    return null;
  }
}

/**
 * With the active record's lock (`file`) held: makes `binding` active with the next generation and fresh evidence with
 * the baseline `takeBaseline()` returns. Returns the new record, or null when the evidence's lock can't be taken.
 */
const startGeneration = (dir, sessionId, file, binding, takeBaseline) => {
  const record = { binding: pickBinding(binding), generation: lastGeneration(file) + 1 };
  const baseline = takeBaseline();
  const evidence = { binding: record.binding, generation: record.generation };
  if (isObject(baseline)) {
    evidence.head = typeof baseline.head === "string" ? baseline.head : null;
    if (Array.isArray(baseline.tags)) evidence.tags = baseline.tags.filter((t) => typeof t === "string");
  }
  evidence.merges = [];
  evidence.offered = [];
  // The fresh evidence goes first, so the active record never names a generation without it.
  const efile = evidenceFile(dir, sessionId, record.generation, record.binding);
  if (!withLock(efile, () => writeAtomic(efile, evidence)).ok) return null;
  writeAtomic(file, record);
  return record;
};

/**
 * The evidence of `binding` in the session's active generation. A missing or unreadable file, or one whose binding or
 * generation isn't the active record's, is fresh: { binding, generation, merges: [], offered: [] } with no baseline.
 * Null when `binding` isn't the active one or a lock can't be taken.
 */
export function loadEvidence(dir, sessionId, binding) {
  const active = activeBinding(dir, sessionId);
  if (!active || !sameBinding(active.binding, binding)) return null;
  const file = evidenceFile(dir, sessionId, active.generation, active.binding);
  const r = withLock(file, () => readEvidence(file, active));
  return r.ok ? r.value : null;
}

/** Whether the active record in `afile` (read without its lock) still names `active`'s binding and generation. */
const isActive = (afile, active) => {
  const now = readActive(afile);
  return !!now && sameBinding(now.binding, active.binding) && now.generation === active.generation;
};

/**
 * Under the evidence file's lock: loads the evidence (as loadEvidence), saves what `change(evidence)` returns with a
 * temporary file and a rename, and returns it. Null when the lock can't be taken within 2 s or `binding` isn't active,
 * also when, once the lock is held, the active record no longer names this binding and generation (`change` isn't called),
 * or when it no longer does once `change` returns (nothing is written). When `change` returns the very evidence it was given, nothing is written.
 */
export function updateEvidence(dir, sessionId, binding, change) {
  const active = activeBinding(dir, sessionId);
  if (!active || !sameBinding(active.binding, binding)) return null;
  const file = evidenceFile(dir, sessionId, active.generation, active.binding);
  const afile = activeFile(dir, sessionId);
  try {
    const r = withLock(file, () => {
      // A relink may have replaced the active generation while this hook waited for the lock: then nothing changes.
      if (!isActive(afile, active)) return null;
      const current = readEvidence(file, active);
      const next = change(current);
      if (next === current) return current;
      if (!isObject(next)) return null;
      // `change` runs git and the active record's lock isn't held: a relink meanwhile makes this evidence obsolete.
      if (!isActive(afile, active)) return null;
      const saved = { ...next, binding: active.binding, generation: active.generation };
      writeAtomic(file, saved);
      return saved;
    });
    return r.ok ? r.value : null;
  } catch {
    return null;
  }
}

/**
 * Follows the session's active record to its link root's binding as read now from disk. With no valid binding there (the
 * link removed, the origin no longer GitHub, or the root now inside another link) it clears the record, keeping its
 * generation so the next binding gets a higher one and fresh evidence (PR 183 r4). With a valid binding that differs in
 * any field it moves the record to that binding with the next generation, fresh evidence and a baseline (PR 183 r5).
 * The same binding keeps its generation and merges. Any hook calls it, shell or not. Returns whether it cleared or moved.
 */
export function leaveStaleBinding(dir, sessionId) {
  if (typeof sessionId !== "string" || !sessionId) return false;
  const file = activeFile(dir, sessionId);
  try {
    const r = withLock(file, () => {
      const current = readActive(file);
      if (!current) return false;
      const now = evidenceBinding(current.binding.root);
      if (!now || now.root !== current.binding.root) {
        writeAtomic(file, { generation: current.generation });
        return true;
      }
      if (sameBinding(now, current.binding)) return false;
      return startGeneration(dir, sessionId, file, now, () => deliveryBaseline(now.root)) !== null;
    });
    return r.ok ? r.value : false;
  } catch {
    return false;
  }
}

/** Whether the link root's binding, read again from disk, is still `binding`. */
const stillBound = (binding) => sameBinding(evidenceBinding(binding.root), binding);

// --- the hooks ------------------------------------------------------------------------------------------------------

/** SessionStart: enters the binding of `cwd` (a resumed session with the same binding keeps its generation and baseline). */
export function startDelivery(dir, sessionId, cwd) {
  leaveStaleBinding(dir, sessionId);
  const binding = evidenceBinding(cwd);
  if (!binding) return null;
  return enterBinding(dir, sessionId, binding, () => deliveryBaseline(binding.root));
}

const hasBaseline = (ev) => (ev.head === null || typeof ev.head === "string") && Array.isArray(ev.tags);

/**
 * PostToolUse for a shell call: enters the binding of `cwd`, records the call's merge command, and returns the hook
 * output with the delivery-check context of each merge of this generation that now has its merge commit and a new
 * deploy tag and wasn't offered yet (marking it offered, under the lock), or null. Runs git only for a merge not yet
 * offered. `env` is the hook's environment (mergeCommand). The link is read again from disk after the git work and before
 * printing: when the binding changed meanwhile, nothing is written, marked or printed.
 */
export function deliveryOnShell(dir, input, cwd, env = process.env) {
  if (!isObject(input) || !SHELL_TOOLS.has(input.tool_name)) return null;
  const sessionId = input.session_id;
  if (typeof sessionId !== "string" || !sessionId) return null;
  const binding = evidenceBinding(cwd);
  if (!binding) return null;
  const pr = mergeCommand(input, binding, env);
  const entered = enterBinding(dir, sessionId, binding, () => deliveryBaseline(binding.root));
  if (!entered) return null;
  let texts = [];
  const saved = updateEvidence(dir, sessionId, binding, (ev) => {
    texts = [];
    let next = ev;
    if (pr !== null && !next.merges.includes(pr)) next = { ...next, merges: [...next.merges, pr] };
    if (!hasBaseline(next)) return next; // a file without the baseline's tags (an older plugin) never prompts
    for (const n of next.merges) {
      if (next.offered.includes(n)) continue;
      const sha = findMergeCommit(binding.root, n, next);
      const tag = sha ? findDeployTag(binding.root, sha, next) : null;
      if (!tag) continue;
      next = { ...next, offered: [...next.offered, n] };
      texts.push(deliveryContext({ binding, pr: n, sha, tag }));
    }
    // A relink (any tool) or an origin moved during the git work: this evidence is no longer the link's, so nothing is written.
    if (texts.length && !stillBound(binding)) {
      texts = [];
      return null;
    }
    return next;
  });
  if (!saved || !texts.length) return null;
  // A relink after the evidence was saved: this hook's binding is no longer the session's, so it prints nothing.
  if (!isActive(activeFile(dir, sessionId), entered) || !stillBound(binding)) return null;
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: texts.join("\n") } };
}
