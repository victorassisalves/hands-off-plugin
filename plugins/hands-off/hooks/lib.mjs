// The hooks' shared library: pure functions the three hook scripts use. Plain Node ESM, no build, no dependencies.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  "deprecate", "record", "release", "redact", "withdraw", "revoke", "pin", "unpin",
]);
const TWO_WORD_WRITE_VERBS = ["add_decisions", "remove_decisions"];
// The Hands-off MCP door that runs a write action by name; actions_run_read and actions_find never write.
const WRITE_DOOR = "actions_run_write";
// The read door: never a write, but a complete hands-off-watch read through it records the watch window (item 83).
const READ_DOOR = "actions_run_read";
// The quick records (decision 95 (e)): written mid-conversation, they neither release the stop gate nor mark a capture.
const QUICK_ACTIONS = new Set(["decision_record", "check_record"]);

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The PostToolUse matcher in hooks/hooks.json (which must use exactly this string): the file and shell tools, apply_patch,
 * and an MCP tool `mcp__<server>__<object>_<write verb>`, the write door or the read door (a hands-off-watch read), under
 * any server. Anchored, with no
 * lookaround or backreferences, so Claude Code (JavaScript) and Codex (Rust's regex crate) read it the same way. The
 * object part has no leading, trailing or doubled underscore, as classifyTool splits the name at its last "__".
 */
export const POST_TOOL_USE_MATCHER = (() => {
  const object = "[^_]+(?:_[^_]+)*";
  const verbs = [...WRITE_VERBS, ...TWO_WORD_WRITE_VERBS].map(escapeRegExp).join("|");
  const builtIn = [...Object.keys(FILE_TOOLS), ...SHELL_TOOLS, "apply_patch"].map(escapeRegExp).join("|");
  return `^(?:${builtIn}|mcp__.+__(?:${object}_(?:${verbs})|${escapeRegExp(WRITE_DOOR)}|${escapeRegExp(READ_DOOR)}))$`;
})();

/** Whether an MCP tool name `<object>_<verb>` has a write verb (and a non-empty object before it). */
export const isWriteTool = (tool) => {
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
export const parseShell = (script) => {
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
export const responseFailed = (response) => {
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

/** The parsed candidates of a tool_response: the object, its structuredContent, the JSON text of content items, a JSON string. */
const answerCandidates = (response) => {
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
  return candidates;
};

/**
 * Finds the Hands-off result in a tool_response: the parsed object itself, its structuredContent, the JSON text of an
 * MCP content item (on an object's `content` or an array), or a JSON string. The first with data.place.project.slug.
 */
const handsOffResult = (response) => answerCandidates(response).find(hasPlace);

/** With a link, the answer's place must be the linked workspace and project (any case); without one, any place counts. */
const placeIsLinked = (place, link) => {
  if (!isObject(link)) return true;
  const workspace = isObject(place.workspace) ? place.workspace.slug : undefined;
  return sameName(place.project.slug, link.project) && sameName(workspace, link.workspace);
};

/**
 * Classifies a PostToolUse input: the files it changed, whether it ran `git commit`, and whether it wrote to Hands-off
 * (a successful MCP write, not a preview, whose Hands-off answer places it in the linked project, or anywhere without
 * `link`). `quick` is such a write that is decision.record or check.record: a quick record, never `recorded`.
 */
export function classifyTool(input, link) {
  const result = { files: [], commit: false, recorded: false, quick: false };
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
    // The write door (decision 77) runs the tool its `action` names ("idea.create" or "idea_create") with `input`.
    const viaDoor = tool === WRITE_DOOR;
    const action = viaDoor ? (typeof toolInput.action === "string" ? toolInput.action.replaceAll(".", "_") : "") : tool;
    const actionInput = viaDoor ? (isObject(toolInput.input) ? toolInput.input : {}) : toolInput;
    if (sep > 5 && server.length > 0 && isWriteTool(action) && actionInput.preview !== true && !responseFailed(input.tool_response)) {
      const answer = handsOffResult(input.tool_response);
      const ok = answer !== undefined && answer.data.preview !== true && placeIsLinked(answer.data.place, link);
      // A quick record (decision 95 (e)) is one decision or check mid-conversation: it doesn't replace the capture map.
      result.quick = ok && QUICK_ACTIONS.has(action.replaceAll(".", "_"));
      result.recorded = ok && !result.quick;
    }
  }
  return result;
}

const STALE = /\btools_out_of_date:/;
const staleIn = (text) => typeof text === "string" && STALE.test(text);

/**
 * Whether an MCP tool's answer carries the server's tools_out_of_date notice (item 95, slice 4a): a Hands-off answer
 * (with data.place) whose last warning is it, or a Hands-off error JSON whose message carries it (a PostToolUseFailure's
 * `error` too).
 */
export function toolsOutOfDate(input) {
  if (!isObject(input) || typeof input.tool_name !== "string" || !input.tool_name.startsWith("mcp__")) return false;
  const candidates = input.hook_event_name === "PostToolUseFailure" ? [parseJson(input.error)] : answerCandidates(input.tool_response);
  return candidates.some((c) => (hasPlace(c) && Array.isArray(c.warnings) && staleIn(c.warnings.at(-1))) ||
    (isObject(c) && isObject(c.error) && typeof c.error.code === "string" && staleIn(c.error.message)));
}

/**
 * The events of a complete hands-off-watch read of the linked project, or null for anything else. Complete means: the
 * read door running activity.list (or activity_list) with `from`, peopleOnly true, type proposals_and_approvals and no
 * other filter (only `project`, `workspace` and `limit` may come with them; a cursor, person, aiOnly, channel, to or any
 * other key narrows the read), answered with data.events, data.next null and data.place in the linked project. Without
 * a link, null.
 */
const WATCH_READ_KEYS = new Set(["from", "peopleOnly", "type", "project", "workspace", "limit"]);

export function watchRead(input, link) {
  if (!isObject(input) || !isObject(link) || typeof input.tool_name !== "string") return null;
  const name = input.tool_name;
  if (!name.startsWith("mcp__")) return null;
  const sep = name.lastIndexOf("__");
  if (sep <= 5 || name.slice(sep + 2) !== READ_DOOR) return null;
  const toolInput = isObject(input.tool_input) ? input.tool_input : {};
  if (toolInput.action !== "activity.list" && toolInput.action !== "activity_list") return null;
  const args = toolInput.input;
  if (!isObject(args)) return null;
  if (typeof args.from !== "string" || !args.from) return null;
  if (args.peopleOnly !== true || args.type !== "proposals_and_approvals") return null;
  if (Object.keys(args).some((k) => !WATCH_READ_KEYS.has(k))) return null;
  if (responseFailed(input.tool_response)) return null;
  const answer = answerCandidates(input.tool_response).find(
    (c) => hasPlace(c) && Array.isArray(c.data.events) && c.data.next === null,
  );
  if (!answer || !placeIsLinked(answer.data.place, link)) return null;
  return answer.data.events.filter((e) => isObject(e) && typeof e.at === "string" && e.at !== "");
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

// --- the watch window (item 83, decision 83) ---------------------------------------------------------------------
// An event exactly at the window's boundary is processed exactly once: the state keeps the `at` of the newest event seen
// (lastAt) and the keys of the events seen at that instant (seenAtLast); the next read starts from lastAt inclusive and
// skips exactly those keys.

/** An activity event's key: at|action|target label|who (a null target or who is empty). */
export function watchKey(event) {
  const e = isObject(event) ? event : {};
  const target = isObject(e.target) && typeof e.target.label === "string" ? e.target.label : "";
  const who = typeof e.who === "string" ? e.who : "";
  return `${e.at ?? ""}|${e.action ?? ""}|${target}|${who}`;
}

/** Compares two ISO instants: by time when both parse, else as strings. */
const compareAt = (a, b) => {
  const x = Date.parse(a);
  const y = Date.parse(b);
  if (Number.isFinite(x) && Number.isFinite(y)) return x - y;
  return a < b ? -1 : a > b ? 1 : 0;
};

const readWatch = (s) => {
  if (!isObject(s) || typeof s.lastAt !== "string" || !s.lastAt || !Array.isArray(s.seenAtLast)) return null;
  return { lastAt: s.lastAt, seenAtLast: [...new Set(s.seenAtLast.filter((k) => typeof k === "string"))] };
};

const watchEvents = (events) => (Array.isArray(events) ? events.filter((e) => isObject(e) && typeof e.at === "string" && e.at) : []);

/** The watch state after a read: { lastAt, seenAtLast[] }; previous (or null) when the read has no newer event. */
export function nextWatchState(previous, events) {
  const prev = readWatch(previous);
  const list = watchEvents(events);
  if (!list.length) return prev;
  let newest = list[0].at;
  for (const e of list) if (compareAt(e.at, newest) > 0) newest = e.at;
  const atNewest = list.filter((e) => compareAt(e.at, newest) === 0).map(watchKey);
  if (!prev) return { lastAt: newest, seenAtLast: [...new Set(atNewest)] };
  const order = compareAt(newest, prev.lastAt);
  if (order < 0) return prev;
  if (order === 0) return { lastAt: prev.lastAt, seenAtLast: [...new Set([...prev.seenAtLast, ...atNewest])] };
  return { lastAt: newest, seenAtLast: [...new Set(atNewest)] };
}

/** The events of a read not processed yet: newer than lastAt, or at lastAt with a key not in seenAtLast. */
export function newEvents(state, events) {
  const s = readWatch(state);
  const list = watchEvents(events);
  if (!s) return list;
  const seen = new Set(s.seenAtLast);
  return list.filter((e) => {
    const order = compareAt(e.at, s.lastAt);
    return order > 0 || (order === 0 && !seen.has(watchKey(e)));
  });
}

// Apart from the record markRecorded writes: one file per repository root plus workspace plus project under watch/.
// The link (optional) names the project; without it, the root's own .handsoff.json does, and with no link there either,
// the root alone keys the state.
const rootLink = (root) => {
  const link = findLink(root);
  return link && link.root === resolve(root) ? link : null;
};

const watchPlace = (root, link) => {
  const l = isObject(link) && typeof link.workspace === "string" && typeof link.project === "string" ? link : rootLink(root);
  return { root: resolve(root), workspace: l ? l.workspace : null, project: l ? l.project : null };
};

const watchFile = (dir, place) => {
  const id = place.workspace === null ? place.root : `${place.root}|${place.workspace}|${place.project}`;
  return join(dir, "watch", `${createHash("sha256").update(id).digest("hex").slice(0, 32)}.json`);
};

/** The watch state of the repository root's linked project (or of `link`'s) on this machine, or null. */
export function loadWatch(dir, root, link) {
  const place = watchPlace(root, link);
  const data = readJson(watchFile(dir, place));
  if (!isObject(data) || data.root !== place.root) return null;
  if ((data.workspace ?? null) !== place.workspace || (data.project ?? null) !== place.project) return null;
  return readWatch(data);
}

export function saveWatch(dir, root, state, link) {
  const s = readWatch(state);
  if (!s) return;
  const place = watchPlace(root, link);
  writeJson(watchFile(dir, place), { ...place, ...s });
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
    `hands-off-capture skill: walk the whole capture map and end with the receipt. A quick record doesn't replace ` +
    `the capture map.`;
  return { decision: "block", reason };
}

/** The session-start line that tells the agent where hands-off-watch reads from. */
const watchLine = (watch, last) => {
  const w = readWatch(watch);
  if (w) {
    const n = w.seenAtLast.length;
    const skip = n === 0
      ? "nothing to skip"
      : `skip the ${plural(n, "event")} already seen at that instant (${w.seenAtLast.join("; ")})`;
    return `To learn what people did in Hands-off since the last check, run the hands-off-watch skill: read from ${w.lastAt} and ${skip}.`;
  }
  if (last) return `To learn what people did in Hands-off since the last capture, run the hands-off-watch skill: read from ${last}.`;
  return `To learn what people did in Hands-off lately, run the hands-off-watch skill: no check is recorded on this machine yet, so read the last 24 hours.`;
};

/** The session-start line that gives the session id to claim a roadmap idea with (decisions 86 and 88). */
const sessionIdLine = (sessionId) =>
  typeof sessionId === "string" && sessionId.trim()
    ? `Your Hands-off session id is ${sessionId.trim()}; pass it as sessionId when you claim a roadmap idea (the hands-off-backlog skill works the ideas in Now, only in a session meant to work the backlog).`
    : `This session has no Hands-off session id from the hook: to claim a roadmap idea, make a random id (a UUID) once and reuse it as sessionId for the whole session (the hands-off-backlog skill works the ideas in Now, only in a session meant to work the backlog).`;

export function sessionStartContext({ link, lastRecordedAt: last, commitsSince, watch, sessionId }) {
  if (!link) return null;
  const lines = [
    `This repository is linked to the Hands-off project ${link.workspace}/${link.project}${link.url ? ` (${link.url})` : ""}.`,
    `Its decisions, pages, components and roadmap ideas live there, read and written through the Hands-off MCP.`,
    `End the session by bringing it up to date with the hands-off-capture skill.`,
    last
      ? `${commitsSince ?? 0} commits since the last capture (${String(last).slice(0, 10)}).`
      : `No capture is recorded on this machine yet.`,
    watchLine(watch, last),
    sessionIdLine(sessionId),
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

// --- the permissions write (item 95, slice 4b) -------------------------------------------------------------------

const SERVER_RULE = "mcp__plugin_hands-off_hands-off";
/** The rules offered (PM call 13): decision_record, the core reads, actions_find and actions_run_read. Never actions_run_write. */
export const OFFERED_RULES = ["decision_record", "context_get", "project_get", "page_list", "page_get", "proposal_get", "proposal_impact",
  "decision_list", "search_query", "search_trail", "actions_find", "actions_run_read"].map((n) => `${SERVER_RULE}__${n}`);
const SETTINGS_LINE = ".claude/settings.local.json";
const ALLOW_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "allow-permissions.mjs");
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10000;
const MAX_CHECKS = 4; // the first hash check, then one after each of 3 re-merges

const gitOk = (root, args) => {
  try {
    return runGit(root, args).trim() || true;
  } catch {
    return false;
  }
};

/** What git does with <root>/.claude/settings.local.json: "tracked", "ignored", "unignored" or "outside" (git). */
export function settingsGitState(root) {
  if (gitOk(root, ["rev-parse", "--is-inside-work-tree"]) !== "true") return "outside";
  if (gitOk(root, ["ls-files", "--error-unmatch", SETTINGS_LINE])) return "tracked";
  return gitOk(root, ["check-ignore", "-q", SETTINGS_LINE]) ? "ignored" : "unignored";
}

const allowList = (file) => {
  const v = readJson(file);
  return isObject(v) && isObject(v.permissions) && Array.isArray(v.permissions.allow) ? v.permissions.allow : [];
};
const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * The session-start offer (decision 95 (g)): once per linked root on this machine, marked in <data>/offers.json whatever
 * the answer. Reads the three settings files, never writes them. Returns the context line, or null with nothing missing.
 */
export function permissionsOffer(data, root, home = homedir()) {
  const file = join(data, "offers.json");
  const offers = readJson(file);
  const roots = isObject(offers) && Array.isArray(offers.roots) ? offers.roots : [];
  if (roots.includes(root)) return null;
  writeJson(file, { roots: [...roots, root] });
  const allowed = new Set([join(root, SETTINGS_LINE), join(root, ".claude", "settings.json"), join(home, ".claude", "settings.json")].flatMap(allowList));
  const missing = allowed.has(SERVER_RULE) ? [] : OFFERED_RULES.filter((r) => !allowed.has(r));
  if (!missing.length) return null;
  const settings = join(root, SETTINGS_LINE);
  const state = settingsGitState(root);
  if (state === "tracked") {
    return `Hands-off permissions: ${missing.join(", ")} aren't allowed yet, but nothing will be written to ${settings}: git tracks that file, and adding it to .gitignore doesn't untrack it. Tell the person once; they can untrack it themselves (git rm --cached ${SETTINGS_LINE}) and ask again.`;
  }
  const git = {
    ignored: "git ignores it, so nothing else changes",
    unignored: `git would commit and share it, so the same yes also adds the line ${SETTINGS_LINE} to ${join(root, ".gitignore")}`,
    outside: "it is outside git, so there is nothing to ignore",
  }[state];
  const command = `node ${quote(ALLOW_SCRIPT)} --root ${quote(root)} ${missing.map((r) => `--rule ${r}`).join(" ")}${state === "unignored" ? " --gitignore" : ""}`;
  return `Hands-off permissions: ask the person once (hands-off-capture, Permissions) whether to allow ${missing.join(", ")} without a prompt in this repository, in ${settings}; ${git}. Only after their explicit yes in this session, run: ${command}`;
}

const digest = (bytes) => (bytes ? createHash("sha256").update(bytes).digest("hex") : "absent");
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const { O_RDONLY, O_RDWR, O_WRONLY, O_CREAT, O_EXCL, O_APPEND, O_NOFOLLOW, O_NONBLOCK = 0 } = fsConstants;
const isLinkError = (e) => e?.code === "ELOOP" || e?.code === "EMLINK"; // O_NOFOLLOW on a symlink (EMLINK on FreeBSD)

/**
 * Reads a file without ever following a symlink at it: { bytes, mode } of a regular file, null when absent, false when
 * the path is a symlink (dangling or not) or not a regular file. Opens with O_NOFOLLOW and reads through that one fd.
 */
const readNoFollow = (file) => {
  let fd;
  try {
    fd = openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    if (isLinkError(e)) return false;
    throw e;
  }
  try {
    const st = fstatSync(fd);
    return st.isFile() ? { bytes: readFileSync(fd), mode: st.mode & 0o777 } : false;
  } finally {
    closeSync(fd);
  }
};
/** The path is absent or a regular file: never a symlink, a directory or anything else. */
const regularOrAbsent = (p) => {
  try {
    return lstatSync(p).isFile();
  } catch (e) {
    return e?.code === "ENOENT";
  }
};

/** O_EXCL|O_NOFOLLOW writers' lock: waits up to 2 s; a lock older than 10 s (mtime) is stale and taken. Returns { content, id } (its fstat), or null. */
const takeLock = (lock) => {
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const content = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
    let fd = null;
    try {
      fd = openSync(lock, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    if (fd !== null) {
      try {
        writeSync(fd, content);
        return { content, id: fstatSync(fd) };
      } finally {
        closeSync(fd);
      }
    }
    try {
      if (Date.now() - lstatSync(lock).mtimeMs > LOCK_STALE_MS) {
        rmSync(lock, { force: true }); // removes the entry itself, never a link's target
        continue;
      }
    } catch {
      continue; // gone meanwhile: try again
    }
    if (Date.now() >= until) return null;
    sleep(50);
  }
};

/**
 * Writes the offered Hands-off rules into <root>/.claude/settings.local.json (hooks/allow-permissions.mjs).
 * No path it reads or writes (the settings file, .gitignore, the lock, the temp file) is ever followed through a symlink:
 * each is opened with O_NOFOLLOW, and the settings file and (with --gitignore) .gitignore are re-checked after the lock
 * wait, at every pass of the merge loop, right before the temp file is created (empty), after it is written and closed,
 * after beforeCheck and right before the rename. Before the temp is created and before the rename it also re-checks that
 * git doesn't track the settings file. Its lock and temp file are removed by identity (dev/ino), even after .claude moved.
 * Seams for the ORDER tests: `afterRead()` under the lock after each read, `beforeCheck()` before each hash check.
 * Returns { ok: true, added: { rules, gitignore? } } or { ok: false, message }.
 */
export function allowPermissions({ root, rules = [], gitignore = false } = {}, { afterRead = () => {}, beforeCheck = () => {} } = {}) {
  const fail = (message) => ({ ok: false, message });
  if (typeof root !== "string" || !existsSync(join(root, LINK_FILE))) return fail(`${root} has no ${LINK_FILE} at it: not a linked repository root; nothing written`);
  const bad = rules.filter((r) => !OFFERED_RULES.includes(r));
  if (bad.length || !rules.length) return fail(`not offered Hands-off rules: ${bad.join(", ") || "none given"}; nothing written`);
  const outside = (what) => fail(`${what} is a symlink or resolves outside the repository ${root}; nothing written`);
  const notRegular = (what) => fail(`${what} is a symlink or not a regular file, or resolves outside the repository ${root}; nothing written`);
  const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
  const claudeDir = join(root, ".claude");
  const gitignoreFile = join(root, ".gitignore");
  if (isLink(claudeDir)) return outside(claudeDir);
  for (const p of [join(root, SETTINGS_LINE), ...(gitignore ? [gitignoreFile] : [])]) if (!regularOrAbsent(p)) return notRegular(p);
  const realRoot = realpathSync(root);
  const realDir = existsSync(claudeDir) ? realpathSync(claudeDir) : join(realRoot, ".claude");
  const rel = relative(realRoot, realDir);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return outside(claudeDir);
  const tracked = () => fail(`${SETTINGS_LINE} is tracked (committed) by git, and .gitignore doesn't untrack it; nothing written`);
  const state = settingsGitState(root);
  if (state === "tracked") return tracked();
  if (state === "unignored" && !gitignore) return fail(`git doesn't ignore ${SETTINGS_LINE} and --gitignore wasn't given; nothing written`);
  const added = {};
  const settings = join(realDir, "settings.local.json");
  mkdirSync(realDir, { recursive: true });
  const idOf = (p) => { try { return lstatSync(p); } catch { return null; } };
  const seen = idOf(claudeDir);
  if (!seen || seen.isSymbolicLink() || !seen.isDirectory()) return outside(claudeDir);
  const changed = fail(`the destination ${claudeDir} changed or is outside the repository ${root}; nothing written`);
  /** <root>/.claude is still the real directory validated above (same dev/ino), and still inside realpath(root). */
  const verifyDir = () => {
    const now = idOf(claudeDir);
    if (!now || now.isSymbolicLink() || !now.isDirectory() || now.dev !== seen.dev || now.ino !== seen.ino) return false;
    try {
      const r = relative(realpathSync(root), realpathSync(claudeDir));
      return Boolean(r) && !r.startsWith("..") && !isAbsolute(r);
    } catch {
      return false;
    }
  };
  const guarded = [settings, ...(gitignore ? [gitignoreFile] : [])];
  /** verifyDir, and the settings file and (with --gitignore) .gitignore absent or regular files: null, or the refusal. */
  const verify = () => {
    if (!verifyDir()) return changed;
    for (const p of guarded) if (!regularOrAbsent(p)) return notRegular(p);
    return null;
  };
  /** Appends the line to .gitignore through one O_NOFOLLOW fd (created if missing, content kept): null, or the refusal. */
  const appendGitignore = () => {
    let fd;
    try {
      fd = openSync(gitignoreFile, O_RDWR | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o644);
    } catch (e) {
      if (isLinkError(e)) return notRegular(gitignoreFile);
      throw e;
    }
    try {
      if (!fstatSync(fd).isFile()) return notRegular(gitignoreFile);
      const text = readFileSync(fd, "utf8");
      writeSync(fd, `${text && !text.endsWith("\n") ? "\n" : ""}${SETTINGS_LINE}\n`);
      return null;
    } finally {
      closeSync(fd);
    }
  };
  const sameId = (a, b) => Boolean(a && b) && a.dev === b.dev && a.ino === b.ino;
  /**
   * Where this run's file `name` (created in the validated .claude) may be now: that directory's real path, and, if the
   * directory was moved or replaced meanwhile, the real directory with its dev/ino among realpath(root)'s entries.
   */
  const placesOf = (name) => {
    const dirs = [realDir];
    try {
      const top = realpathSync(root);
      for (const entry of readdirSync(top)) {
        const d = join(top, entry);
        if (d !== realDir && sameId(idOf(d), seen) && idOf(d).isDirectory()) dirs.push(d);
      }
    } catch {
      // the root itself is gone: only the recorded path is left to try
    }
    return dirs.map((d) => join(d, name));
  };
  /** Removes this run's file by identity: only an entry with the recorded dev/ino (and, given, content), never another run's. */
  const removeOwn = (name, id, content) => {
    for (const p of placesOf(name)) {
      try {
        const now = idOf(p);
        if (!now || !now.isFile() || !sameId(now, id)) continue;
        if (content !== undefined) {
          const got = readNoFollow(p);
          if (!got || got.bytes.toString("utf8") !== content) continue;
        }
        rmSync(p, { force: true });
        return;
      } catch {
        // gone or unreadable: nothing of ours there
      }
    }
  };
  const lockName = `${basename(settings)}.hands-off.lock`;
  const lock = join(realDir, lockName);
  const mine = takeLock(lock);
  if (!mine) return fail("another Hands-off permissions write is running; nothing written");
  /** Removes this run's lock by identity (dev/ino and content), even after <root>/.claude moved; never another run's lock. */
  const releaseLock = () => removeOwn(lockName, mine.id, mine.content);
  let temp = null; // only ever the path this run created exclusively
  let tempId = null;
  const dropTemp = () => {
    if (temp && tempId) removeOwn(basename(temp), tempId);
    temp = null;
    tempId = null;
  };
  /** Re-checked under the lock: git must not track the settings file (it may have been added meanwhile). */
  const trackedNow = () => (gitOk(root, ["ls-files", "--error-unmatch", SETTINGS_LINE]) ? tracked() : null);
  /** Creates a new temp file with O_CREAT|O_EXCL|O_NOFOLLOW: never follows or reuses an existing path or symlink. */
  const openTemp = (mode) => {
    for (let attempt = 0; ; attempt++) {
      const path = `${settings}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
      try {
        const fd = openSync(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode);
        temp = path;
        tempId = fstatSync(fd);
        return fd;
      } catch (e) {
        if (e?.code !== "EEXIST" || attempt >= 4) throw e;
      }
    }
  };
  try {
    let refused = verify();
    if (refused) return refused;
    if (state === "unignored") {
      const now = settingsGitState(root); // under the lock: another run may have added the line meanwhile
      if (now === "tracked") return tracked();
      if (now === "unignored") {
        refused = appendGitignore();
        if (refused) return refused;
        if (settingsGitState(root) !== "ignored") return fail(`git still doesn't ignore ${SETTINGS_LINE}; settings not written`);
        added.gitignore = SETTINGS_LINE;
      }
    }
    for (let check = 0; check < MAX_CHECKS; check++) {
      if ((refused = verify())) return refused;
      const got = readNoFollow(settings);
      if (got === false) return notRegular(settings);
      const bytes = got ? got.bytes : null;
      let value;
      try {
        value = bytes ? JSON.parse(bytes.toString("utf8")) : {};
      } catch {
        value = null;
      }
      const perms = isObject(value) ? value.permissions ?? {} : null;
      if (!isObject(perms) || (perms.allow !== undefined && !Array.isArray(perms.allow))) return fail(`${settings} isn't valid JSON settings (an object with a permissions.allow list); nothing written`);
      afterRead();
      const allow = perms.allow ?? [];
      const fresh = [...new Set(rules)].filter((r) => !allow.includes(r));
      const mode = got ? got.mode : 0o600;
      dropTemp();
      if ((refused = verify() ?? trackedNow())) return refused; // right before the temp is created
      const fd = openTemp(mode);
      try {
        fchmodSync(fd, mode); // over the umask, before any byte is written
        if ((refused = verify())) return refused; // the empty temp is still in the validated directory
        writeSync(fd, JSON.stringify({ ...value, permissions: { ...perms, allow: [...allow, ...fresh] } }, null, 2) + "\n");
      } finally {
        closeSync(fd);
      }
      if ((refused = verify())) return refused;
      beforeCheck();
      if ((refused = verify())) return refused;
      const again = readNoFollow(settings);
      if (again === false) return notRegular(settings);
      if (digest(again ? again.bytes : null) !== digest(bytes)) continue; // edited meanwhile: read and merge again
      if ((refused = verify() ?? trackedNow())) return refused;
      try {
        renameSync(temp, settings);
      } catch (e) {
        return fail(`could not write ${settings} (${e?.code ?? e?.message ?? e}); nothing written`);
      }
      temp = null;
      tempId = null;
      return { ok: true, added: { rules: fresh, ...added } };
    }
    return fail(`${settings} kept changing while it was merged; gave up after ${MAX_CHECKS - 1} re-merges, nothing written`);
  } finally {
    dropTemp();
    releaseLock();
  }
}
