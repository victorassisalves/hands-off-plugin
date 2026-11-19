// PostToolUse hook: records in the session state the files a tool changed, the commits it made and whether it wrote
// to Hands-off; a Hands-off write (one its answer places in the linked project) also marks the linked repository's last
// capture. A complete hands-off-watch read of the linked project (activity.list through the read door) advances the
// linked project's watch window; a read is never a capture. For a shell call it also keeps the session's delivery
// evidence (item 95): a merge command, and once that merge's commit has a new deploy tag, it prints the delivery-check
// context once. It also runs for PostToolUseFailure (item 95, slice 2a): every matched event becomes the session's last
// hook event, and a Hands-off write that failed with a passing server error prints the retry or read-once context
// (hooks/retry.mjs). A Hands-off answer with the tools_out_of_date notice prints the reconnect context once per session
// (item 95, slice 4a). Otherwise prints nothing.
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { deliveryOnShell, leaveStaleBinding, withLock, writeAtomic } from "./delivery.mjs";
import { classifyTool, dataDir, findLink, loadState, loadWatch, markRecorded, nextWatchState, runHook, saveState, saveWatch, toolsOutOfDate, watchRead } from "./lib.mjs";
import { failureContext, noteEvent } from "./retry.mjs";

const RECONNECT = "Tell the person once: Hands-off has new tools; reconnect it (/mcp in Claude Code) or start a new session. Until then, don't guess a tool's fields: use actions_find for the current schema.";

await runHook((input) => {
  if (typeof input.session_id !== "string" || !input.session_id) return null;
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const link = findLink(cwd);
  const data = dataDir(process.env);
  // Any hook, with a link or not: an active delivery binding whose link root lost its valid binding is cleared (item 95).
  try {
    leaveStaleBinding(data, input.session_id);
  } catch {
    // the rest of the hook still runs
  }

  // T for a later failure: this event's time; a failed Hands-off write gets its context (item 95, slice 2a); a stale
  // session's first Hands-off answer, the reconnect context (slice 4a).
  const contexts = [];
  try {
    const now = new Date().toISOString();
    contexts.push(failureContext(data, input, now));
    noteEvent(data, input.session_id, now);
  } catch {
    // the rest of the hook still runs
  }
  try {
    contexts.push(relayOnce(data, input));
  } catch {
    // the rest of the hook still runs
  }
  const text = contexts.filter(Boolean).join(" ");
  const context = text ? { hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: text } } : null;
  // A failed call changed nothing to track.
  if (input.hook_event_name === "PostToolUseFailure") return context;

  const events = watchRead(input, link);
  if (events && link) {
    const next = nextWatchState(loadWatch(data, link.root, link), events);
    if (next) saveWatch(data, link.root, next, link);
    return context;
  }

  const { files, commit, recorded } = classifyTool(input, link);
  if (files.length || commit || recorded) saveChanges(data, input.session_id, cwd, link, { files, commit, recorded });
  if (context) return context;
  return link ? deliveryOnShell(data, input, cwd, process.env) : null;
});

function saveChanges(data, sessionId, cwd, link, { files, commit, recorded }) {
  const state = loadState(data, sessionId);
  // Codex apply_patch gives paths relative to the session's folder: save them absolute.
  for (const file of files.map((f) => (isAbsolute(f) ? f : resolve(cwd, f)))) {
    if (!state.files.includes(file)) state.files.push(file);
  }
  if (commit) state.commits += 1;
  if (recorded) state.recorded = true;
  saveState(data, sessionId, state);
  if (recorded && link) markRecorded(data, link.root, new Date().toISOString());
}

/** RECONNECT the first time this session's Hands-off answer carries tools_out_of_date, else null (`<data>/stale/<session>.json`). */
function relayOnce(data, input) {
  if (!toolsOutOfDate(input)) return null;
  const file = join(data, "stale", `${String(input.session_id).replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  const r = withLock(file, () => !existsSync(file) && (writeAtomic(file, { told: true }), true));
  return r.ok && r.value ? RECONNECT : null;
}
