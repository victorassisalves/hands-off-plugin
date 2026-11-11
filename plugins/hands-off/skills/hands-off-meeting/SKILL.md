---
name: hands-off-meeting
description: Turn a meeting transcript or meeting notes into a Hands-off meeting with its decisions, proposals, pages, ideas and open questions. Use it when the person pastes a transcript (Zoom, Meet, Fathom, Granola or any other) or says they just left a meeting.
---

# Hands-off: after a meeting

1. **Find the project** as in the `hands-off-capture` skill (`.handsoff.json`, then `context_get`). Ask once if it isn't clear.
2. **Read what is there** about the meeting's subjects: `search_query`, `decision_list`, `page_list`.
3. **Extract** from the transcript:
   - participants, each on the `client` or `team` side, with their `personId` from `person_list` whenever they have an account (match by email or name), so "who decided" reads as a person with their organization; an email alone doesn't link the person;
   - every item agreed or discussed, with who proposed it, who agreed, the **exact quote** and the **minute**;
   - for each item: `decided` (agreed in the meeting) or `needs_approval` (only discussed).
4. **Create the meeting** with `meeting_create`. Nothing becomes a decision until a person reviews and records it: give them the link.
5. **Then walk the rest of the capture map** from `hands-off-capture` §3 over the same transcript: rules, pages (ADR, BDR, persona, PRD), components, ideas, open questions, contradictions with what is already approved. The meeting is the source of every one of them, with direct evidence (speaker and minute).
6. **Receipt** as in `hands-off-capture` §6, with the meeting link first.

Keep the transcript out of Hands-off unless the person asks to attach it: only the quotes that support the items are stored.
