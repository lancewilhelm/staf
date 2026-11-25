# Staf specification

Status: draft, 2026-11-24. This document describes what Staf is and the order in which
it gets built. Update it when a decision changes.

## Purpose

Staf is a personal agent system for a household of two people. It
is not a coding agent. It monitors email, produces a daily newspaper, answers everyday
questions, and runs other recurring personal tasks.

Staf does not implement its own agent loop. Existing agent harnesses (Codex, Claude
Code, Antigravity, and others) do the reasoning and the general work, such as shell
commands, files, web search, and skills. Staf hosts those harnesses and adds what they
lack: household integrations, schedules, an inbox, approvals, and a simple interface.

## Principles

1. **Simple on the surface.** Every screen shows the result first. Technical details,
   such as tool calls, sources, token use, and the choice of harness, stay collapsed
   until someone opens them.
2. **Harness-agnostic.** Any supported harness can run any agent or job. Anything that
   Staf depends on (memory, approvals, schedules, identity) lives in Staf, not in a
   harness.
3. **Small and light.** One compiled binary and one SQLite file. The host should idle
   at well under 100 MB of memory. Harness processes start only when work needs them.
4. **Live use before hardening.** Each slice ships as something that we use daily
   before the next slice starts. A feature that only exists as an offline preview is
   not finished.
5. **Mac and Linux.** Windows is out of scope.

## Concepts

| Concept | Meaning |
|---|---|
| **Person** | A member of the household. Each person owns their own threads, agents, jobs, and inbox. |
| **Agent** | A folder with settings (`agent.json`), instructions (`AGENTS.md`), and a `workspace/` that the agent works in. Settings choose the default harness and model, network access, harness apps, and extra writable folders. Each agent has its own memory ([memory.md](memory.md)). See [agents.md](agents.md). |
| **Thread** | A chat conversation with one agent on one provider and model, chosen when it starts. A thread stays on one harness session. |
| **Job** | A run of an agent that a schedule or a trigger starts, such as "every day at 05:30" or "a new email arrived". |
| **Inbox item** | Something that needs a person's attention: a job result, an approval request, or an alert. |
| **Plugin** | An integration, such as Gmail. A plugin adds MCP tools, triggers, and a setup flow. |
| **Harness** | An external agent runtime that Staf drives through an adapter. |

## Architecture

```
            ┌──────────── Web app (React PWA) ─────────────┐
            │  Chat   ·   Inbox   ·   Agents               │
            └──────────────────────┬───────────────────────┘
                                   │ HTTP + server-sent events
   staf (one binary, Bun + TypeScript, Mac or Linux, always on)
   ├─ HTTP API and the embedded web app
   ├─ CLI client (`staf ask`, `staf chat`) that talks to the running host
   ├─ Store: SQLite in ~/.staf/staf.db
   ├─ Threads, jobs, inbox, people
   ├─ Plugins: MCP tools, triggers, setup flows
   ├─ Staf MCP server, reached through `staf mcp-bridge --token <run token>`
   └─ Runner: one adapter interface
        ├─ Codex      codex app-server (JSON-RPC over stdio)
        ├─ ACP        agy acp, hermes acp, and other ACP agents
        └─ Claude     claude in stream-JSON mode (or the Agent SDK)
```

### Repository layout

```
staf/
├─ packages/protocol   shared types and the platform-neutral API client
├─ apps/server         host, harness adapters, MCP bridge, CLI (compiled to one binary)
├─ apps/web            React web app, bundled by Bun and embedded in the binary
└─ apps/mobile         (later) Expo app that reuses packages/protocol
```

### Data on disk

```
~/.staf/                    (override with STAF_HOME)
├─ staf.db                  SQLite: threads, messages, jobs, inbox
├─ harness/codex/           CODEX_HOME for Staf's own Codex sign-in and config
└─ agents/<agent-id>/
   ├─ agent.json            settings; the agent cannot write here
   ├─ AGENTS.md             instructions; the agent cannot write here
   └─ workspace/            the agent's working folder: notes, scripts, skills, outputs
```

[deployment.md](deployment.md) describes every file, backups, and the plan for an
always-on server and remote access.

Staf uses its own harness homes, such as `~/.staf/harness/codex`. A harness home has its
own sign-in to the shared account and its own configuration. This keeps a person's
everyday harness setup (personal MCP servers, hooks, global instructions) out of Staf
runs. It also avoids sharing a refresh token between two copies of a credentials file.

## Harness adapters

Each adapter turns one harness into the same small interface: run a turn in a session,
stream normalized events, interrupt the turn, and report whether the harness is ready.

| Harness | Transport | Instructions | Staf tools |
|---|---|---|---|
| Codex | `codex app-server`, JSON-RPC lines over stdio | `developerInstructions` on `thread/start` and `thread/resume` | Per-thread `config` that adds the Staf MCP bridge |
| Antigravity | `agy acp --sandbox --gemini-dir <Staf's folder>` | `_meta.antigravity.systemPrompt.append` on `session/new` | `mcpServers` in ACP `session/new` |
| Claude | `claude -p --output-format stream-json --safe-mode`, one process per turn | `--append-system-prompt` | `--mcp-config` (check that it works with `--safe-mode`) |
| Hermes (optional) | `hermes acp` | `AGENTS.md` | ACP `mcpServers` |

Agent settings reach the harness as one neutral `access` value (network, harness apps,
writable folders), and each adapter turns it into harness settings. For Codex, harness
apps, computer use, browser use, and plugins are off unless an agent allows specific
apps.

Normalized events: text deltas for the answer, activities (web search, command, tool
call, file change, commentary) with a status, and a final outcome (completed, failed, or
interrupted). The web app and the CLI only ever see these normalized events.

## Staf tools and approvals

The Staf MCP server provides the tools that harnesses do not have, such as Gmail,
inbox delivery, memory, and asking a person a question. Every harness reaches it through
`staf mcp-bridge`, a small stdio process that forwards calls to the host.

Each run gets its own token. The token identifies the person, the agent, the job (if
any), and the allowed plugins. The host checks the token on every call. This is how
One person's jobs are kept away from the other person's mail.

Approvals are enforced inside Staf's tools, not by the harness. A risky action, such as
sending an email, creates an approval request in the owner's inbox and waits. This works
the same way whichever harness made the call.

## Interface

- **Chat** works like a search-engine chat. An empty thread shows one large input.
  Answers stream in as Markdown. A single collapsed line, such as "Searched the web ·
  4 steps", opens to show the activity.
- **Inbox** (slice 2) lists job results and approvals. Each item opens to its full
  result, for example the newspaper PDF.
- **Agents** (slice 2) lists each person's agents and jobs.
- The web app becomes an installable PWA in slice 6, with push notifications. A native
  Expo app can follow later and reuse `packages/protocol`.
- The CLI covers the same chat: `staf ask "question"` prints one answer, and `staf chat`
  opens an interactive conversation.

## Security

- Until slice 6, the host listens only on 127.0.0.1 and has no login. Any local process
  can use it. Slice 6 adds people, sign-in, and access from the home network.
- Harness runs use each harness's sandbox. For Codex, chat runs in `workspace-write`
  mode in the agent's workspace, and commands never ask for escalation. The agent's
  settings and instructions sit outside the workspace, so the agent cannot change them.
- Apps that come with a harness account are off by default, because the household
  shares one login. See [decisions.md](decisions.md).
- Secrets for plugins live in the Staf store, never in agent folders. Harnesses never
  see plugin credentials; they only call Staf tools.
- Email and web content can contain prompt injection. Tools that act on the outside
  world require approval unless a person has granted a standing rule.

## Delivery slices

Each slice is used live before the next one starts.

1. **Chat.**
   - 1a: web chat and CLI on Codex, with streaming answers and collapsible activity. Done.
   - 1b: Antigravity through a generic ACP adapter. Done.
   - 1c: Claude through stream-JSON mode. Done.
   - 1d: provider choice, settings, and cleanup. Next.
     - **Provider pill.** A small pill next to the composer picks the provider and model
       for a new conversation. It starts at the agent's own setting. Once a conversation
       has started, the pill shows its provider and model but cannot change them,
       because a harness session cannot move to another harness. Each provider's models
       come from the harness where it can list them (Codex `model/list`, ACP
       `session/new`), and from a fixed list of aliases for Claude.
     - **Provider notes.** Choosing a provider shows one short line about how it differs,
       such as "Gemini: commands can't reach the internet, and Google may suspend
       accounts that use it for automation." Gemini is marked experimental.
     - **Settings window.** A popup with sections for providers (sign-in status, signing
       in to Codex, and how to sign in to Claude and Antigravity, which use the
       machine's own sign-in), the default provider and model, and, from slice 3,
       memory limits.
     - **One agent.** With the provider picked per conversation, the `claude` and
       `gemini` agents are no longer needed. Their conversations move to the default
       agent, and the agent chips on the new-chat screen go away. Choosing between
       agents comes back with the Agents page in slice 2.
     - **Deleting a conversation deletes both copies:** Staf's, and the harness's own
       transcript (Codex and Antigravity in `~/.staf/harness/`, Claude in
       `~/.claude/projects/`).
     - **Harness memory off,** as listed in [memory.md](memory.md).
2. **Jobs and the inbox.** Schedules, job runs, inbox items with attachments, an Agents
   page, and a port of the `morning-intel` skill from Hermes. Jobs run on Codex or
   Claude; Staf refuses to schedule a job on Antigravity for now (see
   [decisions.md](decisions.md)).
3. **The Staf MCP server and memory v1.** Run tokens, the first Staf tools (inbox
   delivery, `memory`, `conversation_search`), and per-agent memory as designed in
   [memory.md](memory.md), with its limits in the settings window. Check first that
   Claude's `--safe-mode` accepts `--mcp-config`.
4. **Gmail.** Setup, a trigger for new mail, inbox monitoring, the personal feed that
   `morning-intel` reads, and approvals for sending mail.
5. **People.** A second person's account, their own agents and jobs, and per-person scoping.
   Only agents owned by the account holder may allow harness apps.
6. **Reach.** Sign-in, home-network access, the PWA, and push notifications.

Later: a larger memory system with benchmarks (see [memory.md](memory.md)), importing
memories from other assistants, voice, an Expo app, Hermes as a harness, and more
plugins.

## Known gaps

- On Antigravity, commands cannot reach the network and the agent cannot write to
  `writableFolders`, because the only way past agy's sandbox is a bypass that also lifts
  the file limits.
- Every harness keeps its own transcript of each conversation, so conversations are
  stored twice. Claude's transcripts are in `~/.claude/projects/`, outside Staf's data
  folder. Until slice 1d, deleting a conversation in Staf leaves the harness's copy.
- How Antigravity and Claude sign in on a headless Linux server is untested.

- Codex sometimes runs commands through its `exec` tool ("code mode"), which runs a
  short script. The app server does not report those calls, so they do not appear in
  an answer's step list. Turning off the `code_mode_host` feature did not stop it.
  Look for a supported way to see or disable these calls.

## Out of scope

- Writing an agent loop or calling model APIs directly.
- Windows.
- Multi-tenant hosting beyond one household.

## Footprint targets

| Measure | Target |
|---|---|
| Compiled binary | under 100 MB |
| Host memory at idle | under 100 MB |
| Web app, gzipped | under 200 KB |

These are targets. Measure them at the end of each slice.

Measured after slice 1a (macOS arm64, Bun 1.4.5):

| Measure | Result |
|---|---|
| Compiled binary | 90 MB, nearly all of it the Bun runtime |
| Host memory at idle | 24 MB |
| Web app, gzipped | 99 KB of JavaScript and 3 KB of CSS |
