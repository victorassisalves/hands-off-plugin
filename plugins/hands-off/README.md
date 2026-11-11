# Hands-off for Claude

Hands-off is a decision record for consultancies and product teams: clients approve decisions through a link, and your AI keeps the project up to date. This plugin connects your AI to [Hands-off](https://handsoff.inventora.digital) and teaches it to record what each work session decided, designed or changed, with its source.

## Install

In Claude Code:

```bash
claude plugin marketplace add victorassisalves/hands-off-plugin
```

```bash
claude plugin install hands-off@hands-off
```

The first time your AI calls Hands-off, it opens Hands-off in your browser. Sign in and choose the access level and the projects it may reach. You need a Hands-off account (private beta).

## What's inside

| Part | What it does |
| --- | --- |
| MCP server | `https://handsoff.inventora.digital/mcp`, signed in with OAuth. Your AI reads and writes your Hands-off projects through it. It can draft proposals; only people approve them. |
| `hands-off-capture` skill | At the end of a session, brings the project up to date: decisions, rules, pages, components and ideas, each with its source, and a receipt you can check. |
| `hands-off-meeting` skill | Turns a meeting transcript or notes into a Hands-off meeting with its decisions, proposals and open questions. |
| `hands-off-catch-up` skill | Finds what changed in a repository with nothing recorded in Hands-off, and closes the gap. |
| Hooks | At session start, names the linked project. While you work, notes which files changed. Before the session ends, asks once for a capture if the repository changed and nothing was recorded. |

## Link a repository to a project

Add `.handsoff.json` at the repository root:

```json
{ "workspace": "your-workspace", "project": "your-project", "url": "https://handsoff.inventora.digital" }
```

Without this file the hooks stay silent.

## What it sends, and where

- **The MCP server** sends to `handsoff.inventora.digital` only what your AI reads or writes in Hands-off, as your account, within the access you granted. Data is stored in the US. Revoke the connection at any time in Hands-off, under Settings, API keys and MCP.
- **The hooks send nothing over the network.** They run `git` in the linked repository and keep a small state file per session on your machine, in the plugin's data folder: the paths of files changed, a count of commits, and whether the session wrote to Hands-off. File contents are not stored; dirty files are kept only as content fingerprints.
- The skills are instructions to your AI and run nothing by themselves.

Privacy policy: https://handsoff.inventora.digital/pt/privacidade

## License

Proprietary. See [LICENSE](LICENSE).
