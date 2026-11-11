// The hooks' shared library: pure functions the three hook scripts use. Plain Node ESM, no build, no dependencies.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const LINK_FILE = ".handsoff.json";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

const writeJson = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
};

/** Walks up from `dir` to the filesystem root looking for `.handsoff.json`. */
export function findLink(dir) {
  if (typeof dir !== "string" || dir === "") return null;
  let current = resolve(dir);
  for (;;) {
    let text;
    try {
      text = readFileSync(join(current, LINK_FILE), "utf8");
    } catch {
      text = undefined;
    }
    if (text !== undefined) {
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return null;
      }
      if (!isObject(data)) return null;
      const { workspace, project, url } = data;
      if (typeof workspace !== "string" || !workspace || typeof project !== "string" || !project) return null;
      return { workspace, project, url: typeof url === "string" ? url : undefined, root: current };
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// --- classifyTool ---------------------------------------------------------------------------------------------

const FILE_TOOLS = { Edit: "file_path", Write: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };
const SHELL_TOOLS = new Set(["Bash", "shell", "exec_command"]);
// A Hands-off MCP tool is named <object>_<verb>; it writes when its verb is one of these.
const WRITE_VERBS = new Set([
  "create", "update", "edit", "move", "link", "unlink", "connect", "disconnect", "touch", "untouch", "archive", "restore",
  "deprecate", "record", "release", "redact",
]);
const TWO_WORD_WRITE_VERBS = ["add_decisions", "remove_decisions"];

/** Whether an MCP tool name `<object>_<verb>` has a write verb (and a non-empty object before it). */
const isWriteTool = (tool) => {
  for (const verb of TWO_WORD_WRITE_VERBS) {
    if (tool.endsWith(`_${verb}`) && tool.length > verb.length + 1) return true;
  }
  const sep = tool.lastIndexOf("_");
  return sep > 0 && WRITE_VERBS.has(tool.slice(sep + 1));
};

// git commit options that take the next word as their value (so a value like "--dry-run" is not the flag).
const COMMIT_VALUE_OPTIONS = new Set([
  "-m", "-F", "-c", "-C", "-t", "--message", "--file", "--template", "--author", "--date", "--fixup", "--squash",
  "--reuse-message", "--reedit-message", "--cleanup", "--trailer",
]);

/** Whether the words after `git commit` make it a dry run (`--dry-run` or `--dry-run=<value>`), which commits nothing. */
const isDryRun = (args) => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") return false;
    if (a === "--dry-run" || a.startsWith("--dry-run=")) return true;
    if (COMMIT_VALUE_OPTIONS.has(a)) i++;
  }
  return false;
};
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

const patchFiles = (text) => {
  const files = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$/.exec(line);
    if (m) files.push(m[1]);
  }
  return files;
};

/** Splits a shell script into commands (on ; && || | & ( ) and newlines), each a list of words, honouring quotes. */
const parseShell = (script) => {
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
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < script.length; i++) {
    const c = script[i];
    if (c === "'") {
      const close = script.indexOf("'", i + 1);
      const end = close === -1 ? script.length : close;
      word += script.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '"') {
      inWord = true;
      for (i += 1; i < script.length && script[i] !== '"'; i++) {
        if (script[i] === "\\" && i + 1 < script.length) i++;
        word += script[i];
      }
    } else if (c === "\\" && i + 1 < script.length) {
      i++;
      if (script[i] !== "\n") {
        word += script[i];
        inWord = true;
      }
    } else if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "(" || c === ")") {
      endCommand();
    } else if (c === " " || c === "\t" || c === "\r") {
      endWord();
    } else if (c === "#" && !inWord) {
      while (i + 1 < script.length && script[i + 1] !== "\n") i++;
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
};

/** Whether one command's words run `git commit`, or a shell `-c` script that does (Codex: bash -lc "..."). */
const wordsCommit = (words, depth) => {
  let w = words;
  while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1); // FOO=bar git commit
  if (!w.length) return false;
  const exe = w[0].split("/").pop();
  if (SHELLS.has(exe)) {
    if (depth >= 3) return false;
    for (let i = 1; i < w.length; i++) {
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(w[i])) return i + 1 < w.length && scriptCommits(w[i + 1], depth + 1);
      if (!w[i].startsWith("-")) return false;
    }
    return false;
  }
  if (exe !== "git") return false;
  let i = 1;
  while (i < w.length && w[i] === "-C") i += 2;
  return w[i] === "commit" && !isDryRun(w.slice(i + 1));
};

const scriptCommits = (script, depth = 0) => parseShell(script).some((words) => wordsCommit(words, depth));

const commandCommits = (command) => {
  if (typeof command === "string") return scriptCommits(command);
  if (Array.isArray(command) && command.every((p) => typeof p === "string")) {
    return wordsCommit(command, 0) || scriptCommits(command.join(" "));
  }
  return false;
};

/** Whether a tool_response says the call failed: isError / is_error on the object, or isError on an item of an array. */
const responseFailed = (response) => {
  if (Array.isArray(response)) return response.some((item) => isObject(item) && (item.isError === true || item.is_error === true));
  return isObject(response) && (response.isError === true || response.is_error === true);
};

const sameName = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

const hasPlace = (v) =>
  isObject(v) && isObject(v.data) && isObject(v.data.place) && isObject(v.data.place.project) &&
  typeof v.data.place.project.slug === "string" && v.data.place.project.slug !== "";

const parseJson = (text) => {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * Finds the Hands-off result in a tool_response: the parsed object itself, its structuredContent, the JSON text of an
 * MCP content item (on an object's `content` or an array), or a JSON string. The first with data.place.project.slug.
 */
const handsOffResult = (response) => {
  const candidates = [];
  if (isObject(response)) {
    candidates.push(response);
    if (isObject(response.structuredContent)) candidates.push(response.structuredContent);
  }
  const items = Array.isArray(response) ? response : isObject(response) && Array.isArray(response.content) ? response.content : [];
  for (const item of items) {
    if (isObject(item) && typeof item.text === "string") {
      const parsed = parseJson(item.text);
      if (parsed !== undefined) candidates.push(parsed);
    }
  }
  if (typeof response === "string") candidates.push(parseJson(response));
  return candidates.find(hasPlace);
};

/** With a link, the answer's place must be the linked workspace and project (any case); without one, any place counts. */
const placeIsLinked = (place, link) => {
  if (!isObject(link)) return true;
  const workspace = isObject(place.workspace) ? place.workspace.slug : undefined;
  return sameName(place.project.slug, link.project) && sameName(workspace, link.workspace);
};

/**
 * Classifies a PostToolUse input: the files it changed, whether it ran `git commit`, and whether it wrote to Hands-off
 * (a successful MCP write, not a preview, whose Hands-off answer places it in the linked project, or anywhere without
 * `link`).
 */
export function classifyTool(input, link) {
  const result = { files: [], commit: false, recorded: false };
  if (!isObject(input) || typeof input.tool_name !== "string") return result;
  const name = input.tool_name;
  const toolInput = isObject(input.tool_input) ? input.tool_input : {};

  const key = Object.hasOwn(FILE_TOOLS, name) ? FILE_TOOLS[name] : undefined;
  if (key && typeof toolInput[key] === "string" && toolInput[key]) result.files = [toolInput[key]];
  if (name === "apply_patch") {
    const text = typeof toolInput.input === "string" ? toolInput.input : typeof toolInput.patch === "string" ? toolInput.patch : "";
    result.files = patchFiles(text);
  }

  if (SHELL_TOOLS.has(name)) result.commit = commandCommits(toolInput.command);

  if (name.startsWith("mcp__")) {
    const sep = name.lastIndexOf("__");
    const server = name.slice(5, sep);
    const tool = name.slice(sep + 2);
    if (sep > 5 && server.length > 0 && isWriteTool(tool) && toolInput.preview !== true && !responseFailed(input.tool_response)) {
      const answer = handsOffResult(input.tool_response);
      result.recorded = answer !== undefined && answer.data.preview !== true && placeIsLinked(answer.data.place, link);
    }
  }
  return result;
}

// --- session state ----------------------------------------------------------------------------------------------

const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "_");
const sessionFile = (dir, sessionId) => join(dir, "sessions", `${safeName(sessionId)}.json`);
const freshState = () => ({ files: [], commits: 0, recorded: false, reminded: false });

const readBaseline = (b) => {
  if (!isObject(b) || !Array.isArray(b.dirty)) return undefined;
  if (b.head !== null && typeof b.head !== "string") return undefined;
  const out = { head: b.head, dirty: [...new Set(b.dirty.filter((f) => typeof f === "string"))] };
  if (isObject(b.hashes)) {
    out.hashes = {};
    for (const [path, hash] of Object.entries(b.hashes)) {
      if (hash === null || typeof hash === "string") out.hashes[path] = hash;
    }
  }
  return out;
};

/** The session state; `baseline` (git HEAD and dirty paths at session start) is present only when one was saved. */
export function loadState(dir, sessionId) {
  const data = readJson(sessionFile(dir, sessionId));
  if (!isObject(data)) return freshState();
  const state = {
    files: Array.isArray(data.files) ? [...new Set(data.files.filter((f) => typeof f === "string"))] : [],
    commits: Number.isInteger(data.commits) && data.commits > 0 ? data.commits : 0,
    recorded: data.recorded === true,
    reminded: data.reminded === true,
  };
  const baseline = readBaseline(data.baseline);
  if (baseline) state.baseline = baseline;
  return state;
}

export function saveState(dir, sessionId, state) {
  const out = {
    files: [...new Set(state.files ?? [])],
    commits: state.commits ?? 0,
    recorded: state.recorded === true,
    reminded: state.reminded === true,
  };
  const baseline = readBaseline(state.baseline);
  if (baseline) out.baseline = baseline;
  writeJson(sessionFile(dir, sessionId), out);
}

// --- git ---------------------------------------------------------------------------------------------------------

/** git without the GIT_* variables a surrounding git hook exports, always with -C <root>. Throws on failure. */
export function runGit(root, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
}

/**
 * What git sees now in the repository holding `root`: HEAD (null when it has none) and the dirty paths (absolute,
 * resolved through `root`). Null when `root` is not in a git repository or git fails.
 */
export function gitSnapshot(root) {
  let out;
  let prefix;
  try {
    out = runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    prefix = runGit(root, ["rev-parse", "--show-prefix"]).replace(/\r?\n$/, "");
  } catch {
    return null;
  }
  let head = null;
  try {
    head = runGit(root, ["rev-parse", "--verify", "-q", "HEAD"]).trim() || null;
  } catch {
    head = null;
  }
  const dirty = [];
  const entries = out.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const paths = [entry.slice(3)];
    if (entry[0] === "R" || entry[0] === "C") {
      if (i + 1 < entries.length && entries[i + 1]) paths.push(entries[i + 1]);
      i++;
    }
    for (const p of paths) {
      const file = resolve(root, relative(prefix || ".", p));
      if (!dirty.includes(file)) dirty.push(file);
    }
  }
  return { head, dirty };
}

/** The sha256 (hex) of a file's bytes; null when it can't be read (deleted, a folder, no permission). */
export function fingerprint(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/** The fingerprint of each path, keyed by path. */
export function fingerprints(paths) {
  const out = {};
  for (const p of Array.isArray(paths) ? paths : []) if (typeof p === "string") out[p] = fingerprint(p);
  return out;
}

// --- per repository ---------------------------------------------------------------------------------------------

const repoFile = (dir, root) => join(dir, "repos", `${createHash("sha256").update(resolve(root)).digest("hex").slice(0, 32)}.json`);

export function markRecorded(dir, root, at) {
  writeJson(repoFile(dir, root), { root: resolve(root), lastRecordedAt: at });
}

export function lastRecordedAt(dir, root) {
  const data = readJson(repoFile(dir, root));
  return isObject(data) && data.root === resolve(root) && typeof data.lastRecordedAt === "string" ? data.lastRecordedAt : null;
}

// --- decisions and context ---------------------------------------------------------------------------------------

const inside = (root, file) => {
  const rel = relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * What the session changed in git since its baseline: paths dirty now and not at the start, paths dirty at the start
 * whose content fingerprint changed (`hashes`: the current fingerprints of the baseline's dirty paths; a baseline
 * without hashes, saved by an older plugin, keeps excluding its paths), and whether HEAD moved.
 */
export function gitChanges({ baseline, head, dirty, hashes }) {
  const before = new Set(isObject(baseline) && Array.isArray(baseline.dirty) ? baseline.dirty : []);
  const files = [...new Set((Array.isArray(dirty) ? dirty : []).filter((f) => typeof f === "string" && !before.has(f)))];
  const then = isObject(baseline) && isObject(baseline.hashes) ? baseline.hashes : null;
  if (then && isObject(hashes)) {
    for (const p of before) {
      if (typeof p !== "string" || !Object.hasOwn(then, p) || files.includes(p)) continue;
      if ((then[p] ?? null) !== (hashes[p] ?? null)) files.push(p);
    }
  }
  const baseHead = isObject(baseline) ? baseline.head : null;
  // HEAD now, different from the baseline's: a repository with no commit at the start (null) that has one now counts.
  const committed = isObject(baseline) && typeof head === "string" && !!head && head !== baseHead;
  return { files, committed };
}

/**
 * Whether to block the stop; `git` (optional) is gitChanges' result, adding the changes only git saw. With a git
 * baseline, git is the truth for commits: the commit commands counted from their text are ignored.
 */
export function stopDecision({ link, state, input, git }) {
  if (!link || !state) return null;
  if (input && input.stop_hook_active === true) return null;
  if (state.reminded || state.recorded) return null;
  const all = [...(state.files ?? []), ...(isObject(git) && Array.isArray(git.files) ? git.files : [])];
  const files = [...new Set(all.filter((f) => typeof f === "string" && isAbsolute(f) && inside(link.root, f)).map((f) => relative(link.root, f)))];
  const commits = state.baseline ? 0 : (state.commits ?? 0);
  const moved = isObject(git) && git.committed === true;
  if (files.length === 0 && commits === 0 && !moved) return null;

  const changed = [];
  if (files.length) changed.push(plural(files.length, "file"));
  if (commits) changed.push(plural(commits, "commit"));
  else if (moved) changed.push("new commits");
  const list = files.length ? ` (${files.slice(0, 5).join(", ")}${files.length > 5 ? `, +${files.length - 5} more` : ""})` : "";
  const reason =
    `This session changed the repository linked to the Hands-off project ${link.workspace}/${link.project}: ` +
    `${changed.join(" and ")}${list}, and nothing was recorded in Hands-off yet. Before finishing, run the ` +
    `hands-off-capture skill: walk the whole capture map and end with the receipt.`;
  return { decision: "block", reason };
}

export function sessionStartContext({ link, lastRecordedAt: last, commitsSince }) {
  if (!link) return null;
  const lines = [
    `This repository is linked to the Hands-off project ${link.workspace}/${link.project}${link.url ? ` (${link.url})` : ""}.`,
    `Its decisions, pages, components and roadmap ideas live there, read and written through the Hands-off MCP.`,
    `End the session by bringing it up to date with the hands-off-capture skill.`,
    last
      ? `${commitsSince ?? 0} commits since the last capture (${String(last).slice(0, 10)}).`
      : `No capture is recorded on this machine yet.`,
  ];
  return lines.join(" ");
}

export function dataDir(env) {
  const e = env ?? {};
  if (e.CLAUDE_PLUGIN_DATA) return e.CLAUDE_PLUGIN_DATA;
  if (e.PLUGIN_DATA) return e.PLUGIN_DATA;
  return join(tmpdir(), "hands-off-plugin");
}

// --- script helpers ---------------------------------------------------------------------------------------------

/** Reads the hook's JSON object from stdin; anything else → null. */
const readInput = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
};

/** Runs a hook body so that nothing ever breaks the session: any error or bad stdin → exit 0, no output. */
export async function runHook(body) {
  let out;
  try {
    const input = await readInput();
    if (input) out = await body(input);
  } catch {
    out = undefined;
  }
  if (out !== undefined && out !== null) process.stdout.write(JSON.stringify(out) + "\n");
  process.exitCode = 0;
}
