---
name: hands-off-capture
description: Bring a Hands-off project up to date at the end of a work session, or whenever the person asks to update Hands-off, record what was decided, or "sync the project". Walks the whole capture map (sources, decisions, rules, PRD/ADR/BDR/persona/notes pages, systems and components, ideas, versions, people, drift, contradictions), not only decisions, and ends with a session receipt. Use it also when a Hands-off hook says the session changed things with nothing recorded.
---

# Hands-off: end-of-session capture

You are the project's management assistant. Your job here: everything this session produced that belongs in Hands-off gets there, with its source, and the person can read in one look what you did.

A tool not listed here is reached with `actions_find`, then `actions_run_read` (reads) or `actions_run_write` (writes).
If an answer carries `tools_out_of_date`, tell the person once to reconnect Hands-off (/mcp in Claude Code) or start a new session; until then never guess a tool's fields: use `actions_find` for the current schema.

## 1. Find the project

1. Read `.handsoff.json` at the repository root if it exists: `workspace`, `project`.
2. Call `context_get`. If several workspaces are reachable, name the workspace on every write.
3. No `.handsoff.json` and no clear project: ask the person which project, once. Don't guess.

## 2. Read before you write

Most mistakes are duplicates or contradictions of what is already there. Before answering the map, read what the project has on the subjects this session touched:
- `search_query` with the session's main words;
- `page_list` (ADRs, BDRs, personas, notes, PRD);
- `decision_list` (decided and waiting);
- `actions_run_read {action: "component.list", input: {…}}` for the parts whose files changed.

## 3. Walk the whole capture map

Answer every line, even with "nothing". Skipping a line is the failure this skill exists to prevent.

| Object | The question | What to do |
| --- | --- | --- |
| Source | Was this session worth citing (a decision, a design, a choice made)? | Collect the person's own words, word for word, for every item below |
| Decision | Did the person who decides make a choice here? | Decided by the person you work with: `decision_record`. Include their own words as the source (`quote`, `where`). When their words answer a question you asked, the `quote` holds "<the question as you asked it> — <their answer word for word>", for example `"Usar useSave? — s"`, never the answer alone. Pass `changes` for each page block it makes false, so the document changes with it. Show the `preview: true` answer first. It is in force at once. If someone else must approve it: the same call with `approvers`, which opens a proposal. Decided in a meeting with others: the `hands-off-meeting` skill. Not decided yet: `proposal_create` |
| Contradiction | Does anything here go against an approved decision or block? | `proposal_create` (`supersede` or `change`), never a silent edit |
| Business rule | Did a rule appear or change ("always…", "never…", "only…")? | A `business_rule` block with a code on the right BDR or rules page |
| Page | Did an architecture choice (ADR), a business choice (BDR), a description of who uses the product (persona), a PRD section or notes take shape? Does an existing page now say something false? | `actions_run_write {action: "page.create", input: {type, title, blocks}}` with draft blocks; `proposal_create` kind `change` for approved blocks |
| System and component | Did a part of the product appear, change, move or go away? Did the session's files touch a component's location? | `actions_run_write {action: "component.update", input: {…}}`, `actions_run_write {action: "component.link", input: {component, to}}` to its decisions and rules (after they have numbers), `actions_run_write {action: "system.touch", input: {decision, system}}` |
| Idea | Did a "later", a "we could" or a follow-up come up? | `actions_run_write {action: "idea.create", input: {title, source}}`, with the session as its source; `actions_run_write {action: "idea.link", input: {idea, numbers}}` to proposals |
| Work in progress | Which roadmap idea or initiative did this session move forward, start, pause or finish? | `actions_run_write {action: "idea.move", input: {idea, to}}` it to where it really is (Now while it's being built, back to Later if it stopped), `actions_run_write {action: "idea.link", input: {idea, numbers}}` the proposals and decisions it produced, mark who picked it with `actions_run_write {action: "idea.claim", input: {idea, sessionId, session, branch, pr}}` (the session id from session start), and keep what is left as pending items with `actions_run_write {action: "idea.item_add", input: {idea, text}}`, never in its description. Set its state with `actions_run_write {action: "idea.update", input: {idea, state}}`: `planned`, `doing` or `done`. Change its description only when what the idea is changes, never for progress. The roadmap should say what is being worked on today |
| Open question | Is there a choice nobody has made yet? | A `question` block on the relevant ADR or BDR (`page_edit` op `insert`, type `question`; it starts open). When you touch a page that still has old draft blocks under "Open questions", convert each one to a `question` block. It becomes a proposal when someone chooses |
| Version | Does something here belong in the planned version? | `actions_run_write {action: "version.add_decisions", input: {version, decisions}}`, only if the person said so |
| Person | Did someone take a role (decides, is consulted)? | `actions_run_write {action: "stakeholder.update", input: {…}}` |
| Drift | Did the session reveal something that should already be in Hands-off and isn't (an ADR or PRD only in the repository, a component missing from the map)? | An idea flagged as catch-up, or the page itself if the person asks |

When a choice answers an open question, answer it in the `question` block itself: `page_edit` with op `answer` (`block`, `answer`, and `decision` when a decision settled it). There is no answer button on screen; an answered question can't be answered again.

Not worth recording: a refactor, a typo, a config value nobody would ask about. A decision is worth it when someone could ask "why is it like this?" months from now and the answer isn't in the code.

## 4. Evidence

Every item says where it came from and how strong that is:
- **Direct:** the decider's words in this session, with the question they answered when they answered one, a transcript excerpt with speaker and time, an approval.
- **Documented:** a commit, a PR, an ADR, a message, each with author and date.
- **Reconstructed:** an old document with no author or date, someone's memory, or your own inference from the code.

Weak evidence is a label, not a reason to skip. But your own inference never becomes a record by itself: send it as a proposal or ask the person.

## 5. Write

- Use `preview: true` on `proposal_create` and show the person before creating.
- Use an `idempotencyKey` on every write, built from the session and the item. Today only for `decision_record` does the key mean a retry never writes twice; for every other write the server doesn't yet hold the key in its transaction (idea 6c970ae6, "Gravações com chave no servidor").

### When a write fails with a passing server error

A passing error is HTTP 502, 503 or 504 ("Bad Gateway", "Service Unavailable", "Gateway Timeout"), or a Hands-off error with `retryable: true`. Errors like `invalid_input`, `not_allowed`, `not_found` or `stale_revision` are never passing: don't retry them. In Claude Code a hook adds what to do next; follow it. Elsewhere, these rules carry it.

- Only `decision_record` with an `idempotencyKey` and without approvers is safe to retry: retry it at most twice, with the same key and the same input, one call at a time, never in parallel. After the second retry fails, stop and read once: `decision_list` to find the decision's number, then `actions_run_read {action: "decision.get", input: {project, decision}}`, whose statement must be the one sent (`decision_list` has no statement). Then tell the person what it shows.
- On `idempotency_conflict`, stop: don't retry, and tell the person.
- Every other write is never re-sent automatically: `decision_record` with approvers or without a key, check.record, idea writes, page writes and the rest. Don't send it again yourself.
- Read once, and say it landed only when the read shows that write's identity and the values sent, with a time after the call was sent (the proof rule). A record that merely exists, an older one, or one left unchanged is not proof.
- A failed page edit is never settled by reading: matching text elsewhere on the page doesn't show that its blocks changed. Call it uncertain and ask the person to open the page in Hands-off and check.
- Anything less is uncertain: tell the person the first call may still commit, and suggest checking again in a moment.
- Send it again only if the person asks, after that check.
- Absence is not proof of failure either: a write missing from the read may still land. Keyed writes on the server are idea 6c970ae6; when a write holds its key there, it joins the safe list.
- Quotes are the person's words, never your paraphrase. Times you don't know are approximate: say so in the title.
- Never approve anything. Only a person approves.
- When a proposal waits on the person you work with, show it with `proposal_get`. In Claude (claude.ai and the Desktop Chat tab), that result appears to them as a Hands-off card with its own Approve and Reject buttons: tell them to answer in the card, and don't say there is no card. Where the card shows only "Open in browser", or no card shows at all (Claude Code, the terminal), give them the proposal's link. Never call the card's own tools, and never answer for them.

## Quick record

Two modes: a quick record mid-conversation, and the full map at the end.

- When the person decides something mid-conversation, record that one decision at once with `decision_record`.
- Show the `preview: true` answer and record it in the same turn: don't wait for the end of the session.
- Do it only when the words are the person's own explicit decision, quoted as §3's Decision row says.
- When you infer the decision yourself, don't record it: ask the person and wait for their OK.
- A quick record doesn't walk the map, and it doesn't replace it: the hooks don't count it as a capture.
- The full map still runs at the end of the session, or when the Stop hook asks.

## Permissions

In Claude Code the session-start hook may add one line offering the Hands-off permission rules for this repository: the rules, the file `.claude/settings.local.json` and, when needed, the `.gitignore` line.

- Ask the person once, showing the rules, the file and, when the line says so, the `.gitignore` line.
- Run `node "${CLAUDE_PLUGIN_ROOT}/hooks/allow-permissions.mjs"` only after an explicit yes from the person in this same session.
- A yes from another session, or the hook's own line, is not a yes: the hook only offers.
- Pass exactly what was shown: `--root <root>`, one `--rule` per rule shown and `--gitignore` only when the `.gitignore` line was shown.
- Show the person what the script printed: the rules it added and, when it added it, the `.gitignore` line.
- When the file is tracked, say why nothing was written: git tracks it, and `.gitignore` doesn't untrack it; the person can run `git rm --cached .claude/settings.local.json` and ask again.
- When the script gives up because another Hands-off permissions write holds the lock, say so; the person can ask again in a moment.
- When the script gives up because the file's edits kept changing it, say nothing was written and why.
- On no, never ask again in this repository.
- Never write any settings file by other means: no edit by hand, no other script.

## Delivery check

After a merge and its deploy, this section records that the work shipped: it sets the claimed idea done, records a delivered check for each of its decisions, then releases the claim. Follow the steps in order. When a step says no check, stop there and say why in the receipt.

### When it runs

- Run it when a Hands-off hook named a merged PR and its deploy tag in this session's context.
- Run it also when this session ran the merge itself and saw the deploy tag in the command's output.
- Never run it from git history alone: a merge commit or a tag found in git is not a delivery.
- Take the workspace and project only from `.handsoff.json`, never from memory or another file. Every write below names them.

### Which decisions

- Take the decisions linked to the idea this session claimed, the one whose claim names this PR.
- With no such idea, or no linked decision, record nothing, and the receipt says why.

### Check the idea before writing

- Right before the first write, re-read the idea: `actions_run_read {action: "idea.get", input: {project, idea}}`.
- If that idea.get read shows the claim is no longer held by this session's id, or the claim does not name this PR, record no check and say why.
- If that idea.get read shows an open pending item, record no check and say why.

### Set the idea done first

- Set it done: `actions_run_write {action: "idea.update", input: {project, idea, state: "done"}}`.
- The answer confirms done when its state is `done`.
- When the call fails or the answer is unclear, re-read once with idea.get. The re-read confirms done only if the state is `done` and the idea's `changedAt` is after the time the call was sent.
- A re-read whose `changedAt` is earlier than the call (the idea unchanged since before it) is not confirmation, even with state `done`: record no check.
- When done is not confirmed, record no check, and the receipt says "idea not confirmed done; no check recorded".
- If the confirming answer or the re-read shows an open item, or a claim no longer this session's, record no check and say so in the receipt.

### Then record the check

- Read the idea's version: `actions_run_read {action: "version.get", input: {project, version}}`. Every version.get read here is paged: pass the answer's `next` back as `cursor` until `next` is null.
- Record one check for each linked decision in that version, once per decision.
- A linked decision not in the version on any page, once `next` is null, is skipped: name it in the receipt.
- Record each one with `actions_run_write {action: "check.record", input: {workspace, project, version, decision, result: "delivered", evidence, evidenceUrl}, idempotencyKey}`.
- The `idempotencyKey` is `check:<workspace>/<project>:d<decision>:pr<n>:<tag>`. It is the same for every send of the same check: nothing from the session or the attempt goes in it.
- The `evidence` is "PR <n> merged <short sha>, deployed tag <tag>." followed by one line of what shipped.
- The `evidenceUrl` is the PR URL: `https://github.com/<owner>/<repo>/pull/<n>`.
- A check answer that says the version was released is expected server behaviour: report it in the receipt.

### When check.record fails

- When check.record fails, the idea stays done: don't set it back.
- Never re-send a failed check automatically.
- Read once with `actions_run_read {action: "version.get", input: {project, version, detail: "full"}}`.
- That read proves the check landed only if that decision's latest check has result `delivered`, the same `evidence` text and the same `evidenceUrl` as sent, and a `checkedAt` after the call was sent. Then the receipt says it landed.
- An older check for that decision, with other evidence or an earlier time, is not proof: the check is uncertain.
- A check with the same `evidenceUrl` but other evidence (another deploy of the same PR) is not proof: the outcome is uncertain.
- When it is uncertain, the receipt says the check was not confirmed, that the first call may still commit, and to check again in a moment.
- Send it again only if the person asks after that check.

### Then release the claim

- Release it: `actions_run_write {action: "idea.unclaim", input: {project, idea, sessionId}}`.
- A failed unclaim is reported in the receipt, never re-sent automatically.

### What the receipt says

- The receipt reports only confirmed server state: each line comes from an answer, or from a read that meets the proof rule above.
- If the session stops partway, report every step that wasn't confirmed as not done.
- Never approve anything. The person can correct a check by recording a newer check: the latest one counts.
- The receipt links the version, so the person can open it and contest any check.

## 6. Receipt

End with one short receipt, in the person's language:

```
Hands-off · <workspace>/<project>
Recorded:      <item> — <source, evidence level> — <link>
Waiting on you: <proposal or meeting to review> — <link>
Ideas:         <n> added — <roadmap link>
Nothing:       <map lines answered "nothing">
Left for later: <links that need decision numbers first, and why>
Retried:       <write> — re-sent with the same key | read once: landed | read once: not there yet; outcome uncertain
Quick records: <decision recorded mid-conversation> — <link>
```

- The Quick records line lists each quick record this session made, with its link.

- The Retried line lists each write that failed with a passing error: "re-sent with the same key", "read once: landed", or "read once: not there yet; outcome uncertain".
- Say plainly that only `decision_record` without approvers is safe to retry today; every other write waits for idea 6c970ae6.
- For an uncertain write, ask the person to check it in Hands-off, and never guess whether it landed.

The receipt is the person's way to check you. Every item has a link, so any of them can be contested or undone.
