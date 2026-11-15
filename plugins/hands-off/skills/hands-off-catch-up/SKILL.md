---
name: hands-off-catch-up
description: Find and close the drift between a repository and its Hands-off project — commits, ADRs, PRD sections, design docs and components that changed with nothing recorded. Use it when the person asks how far behind the project is, to catch up Hands-off, or when a Hands-off hook reports drift at the start of a session.
---

# Hands-off: catch up on drift

A tool not listed here is reached with `actions_find`, then `actions_run_read` (reads) or `actions_run_write` (writes).

1. **Find the project** as in `hands-off-capture` (`.handsoff.json`, `context_get`).
2. **Measure, before writing anything:**
   - the last time the project changed: `actions_run_read {action: "activity.list", input: {…}}` or `actions_run_read {action: "project.overview", input: {…}}`;
   - commits since then: `git log --since=<that time> --oneline`;
   - documents that live only in the repository: ADRs, PRD, design docs (`docs/`), compared with `page_list`;
   - the open questions: `page_list` gives each page's `questions` count, and `page_get` shows the open `question` blocks of the pages that have any;
   - components whose location matches files changed since then: `actions_run_read {action: "component.list", input: {…}}`, then `git diff --stat <since>..HEAD`.
3. **Show the person the drift** as a short list, grouped: decisions in commits or docs with no record, pages missing, components changed with no linked decision, open questions. Ask what to bring in now. A large catch-up goes in parts.
4. **Bring it in** following `hands-off-capture` §3 to §5. Evidence here is usually **documented** (a commit or a doc with author and date) or **reconstructed** (no author or date): label it, and never turn your own reading of old code into a record without the person confirming.
5. **Receipt** as in `hands-off-capture` §6, plus what drift is left.
