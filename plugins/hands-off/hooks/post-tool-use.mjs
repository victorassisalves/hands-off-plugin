// PostToolUse hook: records in the session state the files a tool changed, the commits it made and whether it wrote
// to Hands-off; a Hands-off write (one its answer places in the linked project) also marks the linked repository's last
// capture. Prints nothing.
import { isAbsolute, resolve } from "node:path";
import { classifyTool, dataDir, findLink, loadState, markRecorded, runHook, saveState } from "./lib.mjs";

await runHook((input) => {
  if (typeof input.session_id !== "string" || !input.session_id) return null;
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const link = findLink(cwd);
  const { files, commit, recorded } = classifyTool(input, link);
  if (!files.length && !commit && !recorded) return null;
  const data = dataDir(process.env);
  const state = loadState(data, input.session_id);
  // Codex apply_patch gives paths relative to the session's folder: save them absolute.
  for (const file of files.map((f) => (isAbsolute(f) ? f : resolve(cwd, f)))) {
    if (!state.files.includes(file)) state.files.push(file);
  }
  if (commit) state.commits += 1;
  if (recorded) state.recorded = true;
  saveState(data, input.session_id, state);
  if (recorded && link) markRecorded(data, link.root, new Date().toISOString());
  return null;
});
