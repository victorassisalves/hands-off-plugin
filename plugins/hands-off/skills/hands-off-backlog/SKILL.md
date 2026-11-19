---
name: hands-off-backlog
description: Work a Hands-off project's roadmap as the backlog. Read the ideas in Now, take the next free idea (planned, nobody picked it), claim it with this session's id, set it to doing, keep its pending items, name the PR on the claim, and at the end set it done and release it. Use it only in a session meant to work the backlog, when the person asks to take the next idea in Now.
---

# Hands-off: work the backlog (Now)

The ideas in Now are the backlog (decisions 86 and 88). A session meant to work it takes the next free idea, marks that it picked it, keeps its pending items on the idea, and releases it when it stops.

A tool not listed here is reached with `actions_find`, then `actions_run_read` (reads) or `actions_run_write` (writes).

## When to claim

- Claim only in a session meant to work the backlog: the person asked for it, or the session was started to take the next idea in Now. Never claim automatically.
- In a session with another task, you may name the next free idea with its link, but never claim it.
- Never approve, and never write as if the person did. Whatever needs a person (an approval, a choice, a change to what is approved) becomes a proposal for them with `proposal_create`.

## 1. Find the project

As in the `hands-off-capture` skill: `.handsoff.json` at the repository root, then `context_get`. If several workspaces are reachable, name the workspace on every write.

## 2. Read Now

Read Now twice, each read filtered, so you never pull the whole bucket:

1. The candidate read: `actions_run_read {action: "roadmap.get", input: {project, bucket: "now", state: "planned", holder: "free", limit: 100}}`. These are the free ideas (planned, nobody picked them), in board order.
2. The unheld-work read: `actions_run_read {action: "roadmap.get", input: {project, bucket: "now", state: "doing", holder: "free", limit: 100}}`. These are doing ideas nobody holds.
3. For each read, when `next` is not null, pass it as `cursor` and read again, until `next` is null.
4. Each continuation repeats the same bucket and filters with the cursor (bucket `now`, the same state, holder `free`): a cursor sent without them is refused.

## 3. Pick the idea

1. Take the first idea of the candidate read. That is the free idea.
2. Read it with `actions_run_read {action: "idea.get", input: {project, idea}}`: its description, pending items and links.
3. Check stale from the links in that answer: an idea is stale when every linked decision is already in code (delivered).
4. Skip a stale planned idea and take the next idea of the candidate read.
5. Skip a planned idea someone claimed since the read: the claim only warns, but the backlog takes free ideas.

## 4. Claim it

1. Your session id comes from session start ("Your Hands-off session id is …"). Without one, make a random id (a UUID) once and reuse it for the whole session.
2. Claim with `actions_run_write {action: "idea.claim", input: {project, idea, sessionId, session, branch}}`: `sessionId` is the session id, `session` a short label (the branch is a fine label), `branch` the branch you work on.
3. Never use a branch name or a role as the session id: the session id names this session only.
4. On `claimed: false` someone holds it: take the next free idea and claim that one.
5. Never pass takeOver unless the person asks for it. Only when the person asked: `actions_run_write {action: "idea.claim", input: {project, idea, sessionId, session, branch, takeOver: true}}`.

## 5. Work it

1. After the claim, set it to doing with `actions_run_write {action: "idea.update", input: {project, idea, state: "doing"}}`.
2. Keep what is left to do as pending items: add each with `actions_run_write {action: "idea.item_add", input: {project, idea, text}}` and check it off when done with `actions_run_write {action: "idea.item_check", input: {project, idea, item, done: true}}`.
3. Never write progress into the description: progress lives in the state, the claim and the pending items.
4. When the PR opens, claim again with the same session id and the PR: `actions_run_write {action: "idea.claim", input: {project, idea, sessionId, session, branch, pr}}`.

## 6. Finish or stop

1. After merge and deploy, set it done with `actions_run_write {action: "idea.update", input: {project, idea, state: "done"}}`.
2. Then release it with `actions_run_write {action: "idea.unclaim", input: {project, idea, sessionId}}`.
3. Stopping before that: release the claim with the same unclaim call and leave its open items as they are, so the next session sees what is left.

## 7. Report

1. Report the idea you took (claimed), with its link.
2. Report every stale planned idea you skipped.
3. Report every idea of the unheld-work read: each is doing and nobody holds it.
4. Give each idea its link, so the person can open it in one click.
