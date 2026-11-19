// Item 95, slice 2a (decision 95 (b)): what the agent is told after a Hands-off write fails with a passing server error.
// - A failure is passing when its text has HTTP 502, 503 or 504, "Bad Gateway", "Service Unavailable" or "Gateway
//   Timeout", or its Hands-off error JSON says `retryable: true`. invalid_input, not_allowed, human_only, not_found,
//   stale_revision and idempotency_conflict never are.
// - Only decision.record (as decision_record or through the write door) with an idempotencyKey and without approvers is
//   re-sent automatically, at most twice, with the same input and key. Every other write is read once and confirmed only
//   under the proof rule (identity, the values sent, a time after T); anything less is uncertain, and it is sent again
//   only if the person asks after a later check. page.edit is never confirmed by reading (PR 185 review). Keyed writes on the server are the 0.4.0 idea 6c970ae6.
// - T is the time of the session's previous hook event (`lastEventAt`). State: `<data>/retries/<session>.json`, under
//   `mkdir <file>.lock` and an atomic write, as the delivery state.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withLock, writeAtomic } from "./delivery.mjs";
import { isWriteTool, responseFailed } from "./lib.mjs";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const WRITE_DOOR = "actions_run_write";
const MAX_RETRIES = 2;
// Error codes that are never passing, whatever the text or `retryable` say (the server marks stale_revision retryable).
const NEVER_PASSING = new Set(["invalid_input", "not_allowed", "human_only", "not_found", "stale_revision", "idempotency_conflict"]);
const PASSING_TEXT = /(?<![\w.])(?:502|503|504)(?![\w.])|\bbad gateway\b|\bservice unavailable\b|\bgateway timeout\b/i;

// --- what failed -----------------------------------------------------------------------------------------------------

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** The Hands-off error object in a failure text ({ error: { code, retryable } } or the error itself), if any. */
const errorObject = (text) => {
  let parsed = parseJson(text);
  if (parsed === undefined) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) parsed = parseJson(text.slice(start, end + 1));
  }
  if (!isObject(parsed)) return undefined;
  if (isObject(parsed.error)) return parsed.error;
  return typeof parsed.code === "string" ? parsed : undefined;
};

/** Whether a failure's text is a passing server error. */
export function isPassingFailure(text) {
  if (typeof text !== "string" || !text) return false;
  const error = errorObject(text);
  if (error && NEVER_PASSING.has(error.code)) return false;
  if (error && error.retryable === true) return true;
  return PASSING_TEXT.test(text);
}

/** The failure texts of a hook input: the PostToolUseFailure `error`, or the texts of a PostToolUse isError answer. */
const failureTexts = (input) => {
  if (input.hook_event_name === "PostToolUseFailure") return typeof input.error === "string" ? [input.error] : [];
  const response = input.tool_response;
  if (!responseFailed(response)) return [];
  const texts = [];
  const items = Array.isArray(response) ? response : Array.isArray(response.content) ? response.content : [];
  for (const item of items) if (isObject(item) && typeof item.text === "string") texts.push(item.text);
  if (isObject(response) && isObject(response.structuredContent)) texts.push(JSON.stringify(response.structuredContent));
  if (isObject(response) && typeof response.error === "string") texts.push(response.error);
  return texts;
};

const passing = (texts) => texts.some(isPassingFailure) && !texts.some((t) => NEVER_PASSING.has(errorObject(t)?.code));

/** The Hands-off write a hook input ran: { action (underscored), input, key }, or null (a read, or not Hands-off). */
const handsOffWrite = (input) => {
  const name = input.tool_name;
  if (typeof name !== "string" || !name.startsWith("mcp__")) return null;
  const sep = name.lastIndexOf("__");
  if (sep <= 5) return null;
  const server = name.slice(5, sep);
  const tool = name.slice(sep + 2);
  if (!/hands[-_]?off/i.test(server)) return null;
  const toolInput = isObject(input.tool_input) ? input.tool_input : {};
  const key = (k) => (typeof k === "string" && k ? k : null);
  if (tool === WRITE_DOOR) {
    const action = typeof toolInput.action === "string" ? toolInput.action.replaceAll(".", "_") : "";
    if (!action) return null;
    // The door's key is its own top-level idempotencyKey; one inside `input` is ignored by the server.
    return { action, input: isObject(toolInput.input) ? toolInput.input : {}, key: key(toolInput.idempotencyKey) };
  }
  if (!isWriteTool(tool)) return null;
  return { action: tool, input: toolInput, key: key(toolInput.idempotencyKey) };
};

const hasApprovers = (input) =>
  input.approvers !== undefined && input.approvers !== null && !(Array.isArray(input.approvers) && input.approvers.length === 0);

const safeToRetry = (write) => write.action === "decision_record" && write.key !== null && !hasApprovers(write.input);

// --- state -----------------------------------------------------------------------------------------------------------

const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "_");
const retriesFile = (dir, sessionId) => join(dir, "retries", `${safeName(sessionId)}.json`);
const isTime = (v) => typeof v === "string" && Number.isFinite(Date.parse(v));

const readState = (file) => {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    raw = undefined;
  }
  const attempts = {};
  if (isObject(raw) && isObject(raw.attempts)) {
    for (const [k, n] of Object.entries(raw.attempts)) if (Number.isSafeInteger(n) && n > 0) attempts[k] = n;
  }
  return { lastEventAt: isObject(raw) && isTime(raw.lastEventAt) ? raw.lastEventAt : null, attempts };
};

const later = (saved, at) => {
  if (!isTime(at)) return saved;
  if (!isTime(saved)) return at;
  return Date.parse(at) > Date.parse(saved) ? at : saved;
};

/** The session's retry state: { lastEventAt: ISO string or null, attempts: { [idempotencyKey]: count } }. */
export function loadRetries(dir, sessionId) {
  return readState(retriesFile(dir, sessionId));
}

/** Records a hook event at `at` (ISO): `lastEventAt` becomes the later of the saved one and `at`, under the lock. */
export function noteEvent(dir, sessionId, at) {
  if (typeof sessionId !== "string" || !sessionId || !isTime(at)) return;
  const file = retriesFile(dir, sessionId);
  withLock(file, () => {
    const state = readState(file);
    const next = later(state.lastEventAt, at);
    if (next !== state.lastEventAt) writeAtomic(file, { ...state, lastEventAt: next });
  });
}

// --- the context -----------------------------------------------------------------------------------------------------

const code = (s) => `\`${s}\``;
const dotted = (action) => action.replaceAll("_", ".");
// No space after a colon, so the call stays in one sentence when the context is split after `.`, `;` and `:`.
const DECISION_GET = code('actions_run_read {action:"decision.get", input:{project, decision}}');

const retryContext = (write, attempt) =>
  [
    `Hands-off answered decision.record (idempotencyKey ${code(write.key)}, no approvers) with a passing server error.`,
    `Retry the same call now, with the same input and the same key ${code(write.key)}: attempt ${attempt} of ${MAX_RETRIES}.`,
    "The key lets the server record it once however many times it arrives. One call at a time; don't tell the person yet.",
    "If the answer is idempotency_conflict, stop and tell the person.",
  ].join(" ");

const stopContext = (write, t) =>
  [
    `decision.record with idempotencyKey ${code(write.key)} failed with a passing server error again, after ${MAX_RETRIES} retries.`,
    "Stop: don't send it again yourself.",
    `Read once: decision_list to find the decision's number, then ${DECISION_GET} for its statement.`,
    t
      ? `It landed only if decision.get shows the title and statement sent and the decision was recorded after T (${t}).`
      : "With no earlier hook event in this session, the outcome can't be established by reading.",
    "Then tell the person: landed, or uncertain (the call may still commit), and that they can check again; send it again only if the person asks.",
  ].join(" ");

/** The read that settles a write, and what in it proves the write landed; null when no read can (page.edit). */
const proofFor = (write) => {
  switch (write.action) {
    case "decision_record":
      return [
        `Read once: decision_list for the project to find its number, then ${DECISION_GET} for its statement, or proposal_get for that number when the write opened a proposal for approvers (it is listed as waiting).`,
        "It landed only if that decision.get (or proposal_get) shows the title and statement sent and a creation after T.",
        "A decision with the same title but another statement is not proof.",
      ];
    case "check_record":
      return [
        `Read once through actions_run_read with version.get (detail: "full") for the version sent.`,
        "It landed only if that decision's latest check has the result sent, the same evidence text and the same evidenceUrl (both, never either alone), and a checkedAt after T.",
        "An older check for that decision is not proof.",
      ];
    case "idea_create":
      return [
        "Read once through actions_run_read with roadmap.get (q set to the title sent), then idea.get on the match.",
        "It landed only if an idea has the title plus the description sent and was created after T.",
        "An idea with the same title but not that description is not proof.",
      ];
    case "idea_update":
      return [
        "Read once through actions_run_read with idea.get for that idea.",
        "It landed only if every field sent equals the value read and its changedAt is after T.",
        "A record left unchanged since before T is not proof, even when its values already match.",
      ];
    // PR 185 review: a page read can't settle a failed page.edit (another edit can show the same text on another
    // block, and a removal leaves nothing to match), so it gets no proof rule.
    case "page_edit":
      return null;
    default:
      return [
        `Read once with the matching get or list for ${dotted(write.action)}.`,
        "It landed only if the read shows the record's identity, the values sent, and a time after T.",
        "A record left unchanged since before T is not proof.",
      ];
  }
};

const readOnceContext = (write, t) => {
  const head = `Hands-off answered ${dotted(write.action)} with a passing server error. Don't send it again yourself: this write is never re-sent automatically.`;
  if (!t) {
    return [
      head,
      "There is no earlier hook event in this session, so there is no time T to compare against and the outcome can't be established by reading: it is uncertain.",
      "The call may still commit. Tell the person, ask them to check again in Hands-off, and send it again only if the person asks after that check.",
    ].join(" ");
  }
  const proof = proofFor(write);
  if (proof === null) {
    return [
      head,
      `T is ${t}, this session's previous hook event.`,
      "Reading the page can't tell whether this edit committed, so don't decide it by reading.",
      "The outcome is uncertain: the call may still commit.",
      "Tell the person, ask them to open the page in Hands-off and check again later, and send it again only if the person asks after that check.",
    ].join(" ");
  }
  return [
    head,
    `T is ${t}, this session's previous hook event.`,
    ...proof,
    "Anything less is uncertain: the call may still commit, and absence is not proof of failure.",
    "Tell the person, ask them to check again later, and send it again only if the person asks after that check.",
  ].join(" ");
};

/**
 * The context for a failed hook input (a PostToolUseFailure input with `error`, or a PostToolUse input whose
 * tool_response has isError), or null. Counts attempts for a keyed decision.record without approvers, reads T from
 * `lastEventAt` and sets `lastEventAt` to the later of it and `now` (an ISO string), all under the session file's lock.
 */
export function failureContext(dir, input, now = new Date().toISOString()) {
  if (!isObject(input) || typeof input.session_id !== "string" || !input.session_id) return null;
  const write = handsOffWrite(input);
  const relevant = write !== null && passing(failureTexts(input));
  const file = retriesFile(dir, input.session_id);
  const held = withLock(file, () => {
    const state = readState(file);
    const t = state.lastEventAt;
    let attempt = 0;
    if (relevant && safeToRetry(write)) {
      attempt = (state.attempts[write.key] ?? 0) + 1;
      state.attempts[write.key] = attempt;
    }
    state.lastEventAt = later(t, now);
    writeAtomic(file, state);
    return { t, attempt };
  });
  if (!relevant) return null;
  // Without the lock nothing can be counted: never re-send, and no T to read against.
  if (!held.ok) return readOnceContext(write, null);
  const { t, attempt } = held.value;
  if (safeToRetry(write)) return attempt <= MAX_RETRIES ? retryContext(write, attempt) : stopContext(write, t);
  return readOnceContext(write, t);
}
