// SessionStart hook: in a repository linked to Hands-off, tells the agent which project it is and how much changed
// since the last capture on this machine, where hands-off-watch reads from next, and saves the session's git baseline (HEAD, the paths already dirty and their content fingerprints) so
// the stop gate also sees changes made by shell commands. It also enters the session's delivery binding (item 95), taking
// the generation's baseline; a resumed session with the same binding keeps it. In Claude Code it also offers the
// Hands-off permission rules once per linked repository (slice 4b); it never writes a settings file or .gitignore.
// Without a link, prints nothing.
import { startDelivery } from "./delivery.mjs";
import { dataDir, findLink, fingerprints, gitSnapshot, lastRecordedAt, loadState, loadWatch, permissionsOffer, runGit, runHook, saveState, sessionStartContext } from "./lib.mjs";

const commitsSince = (root, since) => {
  try {
    const n = Number.parseInt(runGit(root, ["rev-list", "--count", `--since=${since}`, "HEAD"]).trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
};

const saveBaseline = (data, sessionId, root) => {
  try {
    const state = loadState(data, sessionId);
    if (state.baseline) return; // a resumed or compacted session keeps the baseline it started with
    const snapshot = gitSnapshot(root);
    if (!snapshot) return; // outside git: no baseline
    saveState(data, sessionId, { ...state, baseline: { ...snapshot, hashes: fingerprints(snapshot.dirty) } });
  } catch {
    // the context still goes out
  }
};

await runHook((input) => {
  const link = findLink(typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd());
  if (!link) return null;
  const data = dataDir(process.env);
  if (typeof input.session_id === "string" && input.session_id) {
    saveBaseline(data, input.session_id, link.root);
    try {
      startDelivery(data, input.session_id, link.root);
    } catch {
      // the context still goes out
    }
  }
  const last = lastRecordedAt(data, link.root);
  const text = sessionStartContext({ link, lastRecordedAt: last, commitsSince: last ? commitsSince(link.root, last) : 0, watch: loadWatch(data, link.root, link), sessionId: input.session_id });
  if (!text) return null;
  let offer = null;
  if (process.env.CLAUDE_PLUGIN_DATA || process.env.CLAUDE_PLUGIN_ROOT) {
    try {
      offer = permissionsOffer(data, link.root);
    } catch {
      // the context still goes out
    }
  }
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: offer ? `${text} ${offer}` : text } };
});
