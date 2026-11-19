---
name: hands-off-watch
description: Learn what people did in a Hands-off project since the last check (approvals, rejections, comments, recorded meetings) and act on each. Use it when session start names hands-off-watch, when the person asks what changed in Hands-off or what the team approved, or on a scheduled check.
---

# Hands-off: watch what people did

A tool not listed here is reached with `actions_find`, then `actions_run_read` (reads) or `actions_run_write` (writes).
If an answer carries `tools_out_of_date`, tell the person once to reconnect Hands-off (/mcp in Claude Code) or start a new session; until then never guess a tool's fields: use `actions_find` for the current schema.

1. **Find the project** as in the `hands-off-capture` skill (`.handsoff.json`, then `context_get`).
2. **Read since the last check.** Session start gives the instant to read from and the events already seen there; without it, use the last capture time, or the last 24 hours. Read with `actions_run_read {action: "activity.list", input: {project, from, peopleOnly: true, type: "proposals_and_approvals", limit: 50}}` (50 is the most activity.list returns).
   - When `data.next` isn't null, page with `cursor: data.next` (same filters) until it is, so you see everything; then read once more from the same `from`, without a cursor, so the hook records the window.
3. **Skip what you already saw:** the events at the `from` instant that session start lists as seen (or counts) were handled in the last check.
4. **Group the rest per kind** and act on each:
   - an approved proposal whose decision is dev work: queue it for this repository, or name it for the team with its link;
   - a rejection: note it on the linked idea with `actions_run_write {action: "idea.update", input: {project, idea, description}}`, so the idea says what was turned down and why;
   - a comment: read the proposal with `proposal_get`, then answer with `actions_run_write {action: "comment.create", input: {project, proposal, body}}`, adjust the proposal (a new `proposal_create` when its kind changes, or `actions_run_write {action: "proposal.update", input: {…}}`), or open a follow-up proposal;
   - a recorded meeting: its decided items are decisions (`decision_list`); treat each like an approved one.
5. **Report** a short list per kind, each with its link. Nothing new is one short line ("Nothing new in Hands-off since <from>.").

Never approve, and never write as if the person did: an AI comments and proposes as itself. Whatever needs a person (an approval, a choice, a change to what is approved) becomes a proposal for them.

In Claude Code, offer a scheduled check (the session's own loop or a cron job): it reads only the activity, so it costs nothing when nothing is new.
