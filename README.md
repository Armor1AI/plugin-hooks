# plugin-hooks

Armor1 policy plugins for AI coding tools that have no native shell-hook mechanism.

Most clients Armor1 supports (Claude Code, Cursor, Codex, and others) expose a hook
mechanism: the agent installs a hook entry and every tool call is handed to a shared
decision engine, which allows, denies, or annotates it. Some tools have no such
mechanism and can only be extended through a plugin. This repository holds those plugins,
one per client. Each is a thin adapter that reaches the same decision engine from
inside the client's plugin API, so a single policy engine serves every client the same way.

## Layout

One self-contained folder per client, each building to a single bundled JavaScript asset:

| Client | Folder | Status |
|---|---|---|
| OpenCode | [`opencode/`](opencode/) | V1 (`opencode-ai`) and V2 (`@opencode/cli`), one bundle |

See a folder's own README for its design and tests.