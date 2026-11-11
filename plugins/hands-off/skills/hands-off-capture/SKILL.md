---
name: hands-off-capture
description: Bring a Hands-off project up to date at the end of a work session, or whenever the person asks to update Hands-off, record what was decided, or "sync the project". Walks the whole capture map (sources, decisions, rules, PRD/ADR/BDR/persona/notes pages, systems and components, ideas, versions, people, drift, contradictions), not only decisions, and ends with a session receipt. Use it also when a Hands-off hook says the session changed things with nothing recorded.
---

# Hands-off: end-of-session capture

You are the project's management assistant. Your job here: everything this session produced that belongs in Hands-off gets there, with its source, and the person can read in one look what you did.

## 1. Find the project

1. Read `.handsoff.json` at the repository root if it exists: `workspace`, `project`.
2. Call `context_get`. If several workspaces are reachable, name the workspace on every write.
3. No `.handsoff.json` and no clear project: ask the person which project, once. Don't guess.

## 2. Read before you write

Most mistakes are duplicates or contradictions of what is already there. Before answering the map, read what the project has on the subjects this session touched:
- `search_query` with the session's main words;
- `page_list` (ADRs, BDRs, personas, notes, PRD);
- `decision_list` (decided and waiting);
- `component_list` for the parts whose files changed.

## 3. Walk the whole capture map

Answer every line, even with "nothing". Skipping a line is the failure this skill exists to prevent.

| Object | The question | What to do |
| --- | --- | --- |
| Source | Was this session worth citing (a decision, a design, a choice made)? | Collect the person's own words, word for word, for every item below |
| Decision | Did the person who decides make a choice here? | Decisions already made: one `meeting_create` for the session, each as an item of kind `decided` with the person's quote. The person reviews and records it; you never do. Not yet made: `proposal_create` |
| Contradiction | Does anything here go against an approved decision or block? | `proposal_create` (`supersede` or `change`), never a silent edit |
| Business rule | Did a rule appear or change ("always…", "never…", "only…")? | A `business_rule` block with a code on the right BDR or rules page |
| Page | Did an architecture choice (ADR), a business choice (BDR), a description of who uses the product (persona), a PRD section or notes take shape? Does an existing page now say something false? | `page_create` with draft blocks; `proposal_create` kind `change` for approved blocks |
| System and component | Did a part of the product appear, change, move or go away? Did the session's files touch a component's location? | `component_update`, `component_link` to its decisions and rules (after they have numbers), `system_touch` |
| Idea | Did a "later", a "we could" or a follow-up come up? | `idea_create`, with the session as its source; `idea_link` to proposals |
| Work in progress | Which roadmap idea or initiative did this session move forward, start, pause or finish? | `idea_move` it to where it really is (Now while it's being built, back to Later if it stopped), `idea_link` the proposals and decisions it produced, and name the branch or PR in its description. The roadmap should say what is being worked on today |
| Open question | Is there a choice nobody has made yet? | A draft block under "Open questions" on the relevant ADR or BDR. It becomes a proposal when someone chooses |
| Version | Does something here belong in the planned version? | `version_add_decisions`, only if the person said so |
| Person | Did someone take a role (decides, is consulted)? | `stakeholder_update` |
| Drift | Did the session reveal something that should already be in Hands-off and isn't (an ADR or PRD only in the repository, a component missing from the map)? | An idea flagged as catch-up, or the page itself if the person asks |

Not worth recording: a refactor, a typo, a config value nobody would ask about. A decision is worth it when someone could ask "why is it like this?" months from now and the answer isn't in the code.

## 4. Evidence

Every item says where it came from and how strong that is:
- **Direct:** the decider's words in this session, a transcript excerpt with speaker and time, an approval.
- **Documented:** a commit, a PR, an ADR, a message, each with author and date.
- **Reconstructed:** an old document with no author or date, someone's memory, or your own inference from the code.

Weak evidence is a label, not a reason to skip. But your own inference never becomes a record by itself: send it as a proposal or ask the person.

## 5. Write

- Use `preview: true` on `proposal_create` and show the person before creating.
- Use an `idempotencyKey` on every write, built from the session and the item, so a retry never writes twice.
- Quotes are the person's words, never your paraphrase. Times you don't know are approximate: say so in the title.
- Never approve anything. Only a person approves.

## 6. Receipt

End with one short receipt, in the person's language:

```
Hands-off · <workspace>/<project>
Recorded:      <item> — <source, evidence level> — <link>
Waiting on you: <proposal or meeting to review> — <link>
Ideas:         <n> added — <roadmap link>
Nothing:       <map lines answered "nothing">
Left for later: <links that need decision numbers first, and why>
```

The receipt is the person's way to check you. Every item has a link, so any of them can be contested or undone.
