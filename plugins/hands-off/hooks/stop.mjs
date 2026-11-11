// Stop hook: when the session changed the linked repository and recorded nothing in Hands-off, blocks the stop once
// and asks the agent to run the hands-off-capture skill. Changes are the files and commits the tools reported plus,
// when session-start saved a git baseline, what git sees now that it didn't then (shell edits, a moved HEAD).
// Otherwise prints nothing.
import { dataDir, findLink, fingerprints, gitChanges, gitSnapshot, loadState, runHook, saveState, stopDecision } from "./lib.mjs";

await runHook((input) => {
  if (typeof input.session_id !== "string" || !input.session_id) return null;
  const link = findLink(typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd());
  if (!link) return null;
  const data = dataDir(process.env);
  const state = loadState(data, input.session_id);
  let git;
  if (state.baseline && !state.reminded && !state.recorded && input.stop_hook_active !== true) {
    const now = gitSnapshot(link.root);
    if (now) {
      const hashes = state.baseline.hashes ? fingerprints(state.baseline.dirty) : undefined;
      git = gitChanges({ baseline: state.baseline, head: now.head, dirty: now.dirty, hashes });
    }
  }
  const decision = stopDecision({ link, state, input, git });
  if (!decision) return null;
  saveState(data, input.session_id, { ...state, reminded: true });
  return decision;
});
