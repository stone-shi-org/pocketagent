# AGENTS.md

This file provides guidance and rules for agentic AI coding assistants (including Antigravity, Claude Code, and others) when working in the PocketAgent repository.

## Reference Document

See [CLAUDE.md](file:///data/homes/stoneshi/src/agents-remote-control/CLAUDE.md) for the authoritative repository instructions, developer commands, unit testing guides, and architectural details. Follow all guidelines therein to maintain consistency and prevent breaking critical invariants.

---

## Workspace Layout & Key Modules

PocketAgent is a monorepo configured with `pnpm` workspace packages:
* [packages/protocol](file:///data/homes/stoneshi/src/agents-remote-control/packages/protocol) — Single source of truth containing Zod schemas for HTTP bodies and WebSocket frames. **Must be built before anything else works.**
* [apps/server](file:///data/homes/stoneshi/src/agents-remote-control/apps/server) — Fastify server, driving child terminals and tmux sessions.
* [apps/web](file:///data/homes/stoneshi/src/agents-remote-control/apps/web) — Frontend Vite + React application.

---

## Core Agent Guidelines & Rules

When modifying code or running tasks, agents must strictly adhere to the following:

### 1. Invariants (Do Not Break)
* **Never Auto-Approve:** Auto-approval is disabled; all tool executions and approvals are routed directly to the client browser. There is no timeout on pending approvals.
* **Safe Directory Containment Check:** Containment is checked via `fs.realpath` + `path.relative` in [`workspaces/index.ts`](file:///data/homes/stoneshi/src/agents-remote-control/apps/server/src/workspaces/index.ts). Never use simple string prefix matching.
* **No Adopted Tmux Resizing:** Never resize tmux panes automatically for adopted sessions.
* **Sanitize Child Environments:** Strip all environment variables prefixed with `POCKETAGENT_*` in [`sessions/env.ts`](file:///data/homes/stoneshi/src/agents-remote-control/apps/server/src/sessions/env.ts) to prevent token leaks.
* **No Persistent Terminal Logs:** Terminal I/O is held in-memory via [`terminal/output-buffer.ts`](file:///data/homes/stoneshi/src/agents-remote-control/apps/server/src/terminal/output-buffer.ts) and [`terminal/event-buffer.ts`](file:///data/homes/stoneshi/src/agents-remote-control/apps/server/src/terminal/event-buffer.ts); do not store output buffers in the database.

### 2. Code Style & Standards
* **ESM Throughout:** The project uses ES modules. Relative imports must explicitly carry the `.js` extension (e.g. `import { foo } from './foo.js'`), even in TypeScript sources.
* **Frontend styling:** CSS tokens are configured at the top of [`apps/web/src/styles.css`](file:///data/homes/stoneshi/src/agents-remote-control/apps/web/src/styles.css). Avoid ad-hoc styling outside of it.
* **React State & Routing:** React state is hand-rolled using simple hooks. Avoid introducing heavy routers or state management libraries.
* **Explain the "Why":** Comments should explain the rationale behind the code (e.g. why an arbitrary choice was made), not what the code does.

---

## Developer Command Quick-Reference

For more command variations and troubleshooting steps, consult [CLAUDE.md](file:///data/homes/stoneshi/src/agents-remote-control/CLAUDE.md).

```bash
pnpm install            # Build native modules (node-pty, better-sqlite3)
pnpm dev                # Start API dev server (:8787) + Vite dev server (:5173)
pnpm build              # Build protocol -> server -> web (in order)
pnpm start              # Start the production Fastify server
pnpm lint               # Run eslint lint checks across packages
pnpm typecheck          # Run type checks across packages
pnpm test               # Run all tests using vitest
pnpm generate-token     # Generate secure auth token in .env
```
