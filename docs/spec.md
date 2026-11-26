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
| **Person** | A member of the household. Each person owns their own threads, agents, scheduled tasks, preferences, and integrations. |
| **Agent** | A folder with settings (`agent.json`), instructions (`AGENTS.md`), and a `workspace/` that the agent works in. Settings choose its default harness and model, network access, harness apps, and extra writable folders. Each agent owns its own scheduled tasks and memory ([memory.md](memory.md)). See [agents.md](agents.md). |
| **Thread** | One conversation or scheduled task run with an agent. It starts on the agent's default provider and model, and the person can change them during the thread. A thread can hold message attachments (such as a PDF) and can be settled once handled. |
| **Scheduled task** | A recurring or triggered run attached to one agent, such as "every day at 05:30" or "a new email arrived". Each run creates a thread marked with a schedule icon. |
| **Inbox** | The queue of unsettled threads, scheduled task runs, and pending approvals or proposals that need a person's attention, cleared as items are settled. |
| **Plugin** | An integration, such as Gmail. A plugin adds MCP tools, triggers, and a setup flow. |
| **Harness** | An external agent runtime that Staf drives through an adapter. |

## Architecture

```
            ┌──────────── Web app (React PWA) ─────────────┐
            │  Sidebar (Agents · Threads/Inbox) · Chat     │
            │  Agent panel (Profile · Scheduled tasks)     │
            └──────────────────────┬───────────────────────┘
                                   │ HTTP + server-sent events
   staf (one binary, Bun + TypeScript, Mac or Linux, always on)
   ├─ HTTP API and the embedded web app
   ├─ CLI client (`staf ask`, `staf chat`) that talks to the running host
   ├─ Store: SQLite in ~/.staf/staf.db
   ├─ Threads, attachments, scheduled tasks, preferences, people
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

- **Chat** works like a search-engine chat. A new thread shows the current agent's name
  above one large input. Answers stream in as Markdown. A single collapsed line, such as
  "Searched the web · 4 steps", opens to show the activity.
- **Threads and Inbox** (slice 2): Every chat and every scheduled task run is a thread.
  Scheduled task runs carry a small schedule icon (such as a clock) so that they stand
  apart from threads that a person started. In **Settings → Appearance**, each person
  chooses between two sidebar modes:
  - **Inbox mode:** the **Inbox** sits up top with idle threads that nobody has settled
    yet. Threads that are answering right now sit in a bottom-aligned **Working** section
    just above the collapsible **Settled** section at the bottom.
  - **Thread list mode:** a typical chat list. Every thread, whether manual or scheduled,
    running or idle, appears in one list sorted by last activity. Settling does not apply
    in this mode, so the list has no Inbox or Settled sections.
- **Time on threads:** each sidebar row shows a compact time. A running thread shows how
  long it has been working (such as "3m"), and an idle thread shows how long ago it last
  changed (such as "2h"). In a thread, the step summary and the thinking indicator show the
  elapsed time of the answer.
- **Turn stats:** Staf records stats for each answer in `staf.db`: duration, time to first
  token, step count, the resolved model, the stop reason, and token usage and cost when the
  harness reports them. The raw usage payload from each harness is kept only in the
  database for later analysis. Clients receive the normalized stats on each message, but
  the web app does not show them yet. Per-provider usage views come in a later slice.
- **Agent panel** (slice 2): Each agent's own settings (profile, instructions, defaults,
  access summary, and scheduled tasks — and later memory and integrations) open in an
  agent-specific popup or drawer from the sidebar rather than crowding global Settings.
- **Synced preferences** (slice 2): Appearance and sidebar preferences (theme, heading
  font, and Inbox vs. Thread list mode) are stored on the host per person and synced
  across all devices and sessions.
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
   - 1d: agents, settings, and cleanup. Done.
     - **Agents are profiles.** An agent is a named assistant with its own
       instructions, workspace, and memory, and a default provider and model. For
       example, "Staf" for everyday questions and "Paper" for the newspaper.
     - **The pill.** A small pill next to the composer shows the model or provider, and
       the reasoning level and fast mode when they are set, for example "Opus 5.5 ·
       High". It adds the agent's name once there is more than one agent. Its menu picks
       the agent for a new conversation, and the provider, model, reasoning level, and
       fast mode for this conversation. A new conversation starts with the agent's
       defaults.
     - **Reasoning levels and fast mode.** Each model lists the levels it offers, and
       whether it has a fast mode. Codex takes `effort` and the `priority` service tier
       on `turn/start`; Claude takes `--effort` and `fastMode` in `--settings`;
       Antigravity lists each level as a separate model, which Staf merges into one model
       with levels. Fast mode is off by default, because it costs more (see
       [agents.md](agents.md)).
     - **Changing the model or provider during a conversation.**
       - Another model, level, or fast setting on the same provider applies from the next
         message, in the same harness session.
       - Another provider starts a new harness session, because a session cannot move
         between harnesses. Staf gives the new session the earlier conversation as text,
         and the thread shows a divider such as "Switched to Claude". The new provider
         sees the earlier questions and answers, but not the details of earlier steps,
         such as command output.
       - A conversation remembers its own provider and model, so reopening it continues
         where it left off.
     - **Settings window.** A popup with two sections:
       - **Agents:** create, edit, and delete agents. Each has a name, instructions,
         default provider, model, reasoning level, and fast mode. Access settings are
         shown but edited in `agent.json`. Each provider's models come from the harness
         (Codex `model/list`, ACP `session/new`, and Claude Code's `initialize` request).
         Memory limits are added here in slice 3.
       - **Providers:** sign-in status, signing in to Codex, and how to sign in to
         Claude and Antigravity, which use the machine's own sign-in.
     - **Provider notes.** Choosing a provider, for an agent or in the pill, shows one
       short line about how it differs, such as "Gemini: commands can't reach the internet, and Google may
       suspend accounts that use it for automation." Gemini is marked experimental.
     - **Clean up the test agents.** The `claude` and `gemini` agents from slice 1 only
       differ by provider. They are removed, and their conversations move to the default
       agent. The agent chips on the new-chat screen are replaced by the pill.
     - **Deleting a conversation deletes both copies:** Staf's, and the harness's own
       transcript (Codex and Antigravity in `~/.staf/harness/`, Claude in
       `~/.claude/projects/`).
     - **Harness memory off,** as listed in [memory.md](memory.md).
     - **Light and dark themes.** Settings → Appearance picks System, Light, or Dark,
       saved in each browser. Colors are CSS variables that `data-theme` on `<html>`
       selects, so richer themes can be added later as more values.
   - 1e: agents in the sidebar. Done.
     - The left sidebar lists the agents above the conversations, with a `+` button to
       create an agent and a hover edit button on each agent, both of which open
       Settings → Agents. Picking an agent starts a new chat with it and marks it as the
       current agent.
     - Conversations in the sidebar filter to the current agent by default, so that
       clicking an agent shows its conversations at once. When there is more than one
       agent, an "All agents" toggle shows conversations across all agents with the
       owning agent's name under each title.
     - The pill under the composer keeps only the provider, model, reasoning level, and
       fast mode. On a new chat, the hero shows the current agent's name instead of a
       generic prompt. **Settings → Appearance** lets each browser pick the hero heading
       font from five bundled and system options (Bricolage Grotesque, Space Grotesk,
       System sans, Fraunces Soft, and System serif).
     - On phones, the agents sit in the same slide-out sidebar above the conversations.
2. **Scheduled tasks, unified Inbox, and agent settings.**
   - 2a: host-synced user preferences and the dedicated agent settings panel. Done.
     - **User-scoped preferences:** Store theme, heading font, and sidebar mode in
       `staf.db` (`GET` and `PATCH /api/preferences`, plus `preferences.changed` live
       events) so that appearance settings sync across every browser and device, using
       `localStorage` only as a pre-paint cache and migrating older browser-local settings
       once on first connect.
     - **Agent settings panel:** Move agent creation, editing, and deletion out of global
       Settings into a dedicated slide-over panel opened from the sidebar, structured with
       a section nav (**Profile** now, ready for **Scheduled tasks** and **Memory**). Keep
       global Settings focused on **Providers**, **Appearance**, and (later) **People**.
   - 2b: unified Inbox, settle/unsettle state, sidebar modes, and message attachments. Done.
     - **Unified Inbox and sidebar modes:** Add `source` (`"chat"` or `"schedule"`) and
       `settledAt` state to threads (`PATCH /api/threads/:id` with `settled`, automatic
       unsettle on reply, schedule clock icon on scheduled runs), and add the **Sidebar**
       mode selector in **Settings → Appearance** to switch between **Inbox mode**
       (the **Inbox** up top for idle threads that are not settled, with **Working** and a
       collapsible **Settled** section anchored at the bottom) and **Thread list mode** (one
       chronological list of every thread).
     - **Working time and turn stats:** Show working time and thread age on sidebar
       rows and elapsed time on answers, and store per-answer stats and raw harness usage
       in `staf.db` (see **Interface**).
     - **Message attachments:** Store and serve files attached to messages in
       `~/.staf/attachments/` (`POST /api/threads/:id/attachments`,
       `POST /api/threads/:id/messages/:messageId/attachments`, `GET /api/attachments/:id`,
       and live `message.attachment` events), attach files from the composer (copied into
       the agent workspace so the harness can read them), and display inline images,
       expandable PDF previews, and file download cards right in the thread.
   - 2c: per-agent scheduled tasks. Done (code); next live step: port `morning-intel`.
     - **Scheduled tasks:** Define, pause, edit, delete, and run scheduled tasks per agent
       inside the **Scheduled tasks** tab of that agent's panel (`daily` with optional
       weekdays, `interval`, or `once`, stored in `scheduled_tasks` in `staf.db`). Each run
       creates a thread titled `<Task> · <Date>` marked with a schedule clock icon so that
       a person can inspect it and reply to it directly. Scheduled tasks run on Codex or
       Claude; Staf refuses to schedule a task on Antigravity for now (see
       [decisions.md](decisions.md)), and fast mode stays off unless turned on explicitly.
     - **First live scheduled task:** Port the `morning-intel` skill from Hermes into a
       local agent workspace and run it live.
3. **The Staf MCP server and memory v1.** Run tokens, the first Staf tools (inbox
   delivery, scheduled task tools so that an agent can manage its own schedules, `memory`,
   and `conversation_search`), and per-agent memory as designed in [memory.md](memory.md),
   with memory blocks and limits in each agent's panel and proposals surfacing as cards in
   threads and the Inbox. Check first that Claude's `--safe-mode` accepts `--mcp-config`.
4. **Gmail.** Setup, a trigger for new mail, inbox monitoring, the personal feed that
   `morning-intel` reads, and inline approval cards for sending mail in threads and the
   Inbox.
5. **People.** A second person's account, their own agents, scheduled tasks, preferences,
   and per-person scoping. Only agents owned by the account holder may allow harness apps.
6. **Reach.** Sign-in, home-network access, the PWA, and push notifications.

Later:
- **Single-stream mode** per agent (one ongoing timeline alongside standard thread mode,
  with clean session rollover backed by slice 3 memory and conversation search).
- **Sub-tasks and agent-to-agent collaboration** (studying how harnesses and hosts such
  as T3 Code orchestrate sub-tasks; letting agents coordinate with one another and join
  group threads in both thread mode and single-stream mode).
- A larger memory system with benchmarks (see [memory.md](memory.md)), importing memories
  from other assistants, voice, an Expo app, Hermes as a harness, and more plugins.

## Known gaps

- On Antigravity, commands cannot reach the network and the agent cannot write to
  `writableFolders`, because the only way past agy's sandbox is a bypass that also lifts
  the file limits.
- Every harness keeps its own transcript of each conversation, so conversations are
  stored twice. Claude's transcripts are in `~/.claude/projects/`, outside Staf's data
  folder. Deleting a conversation in Staf deletes the harness's copy as well.
- Antigravity's automatic knowledge (`implicit/`) cannot be turned off, and every
  Antigravity conversation in Staf shares it. See [memory.md](memory.md).
- Staf's API has no sign-in, and commands that an agent runs can reach it. The API
  therefore cannot change an agent's access settings, but it can change instructions and
  start conversations with other agents. Slice 6's sign-in closes this.
- Signing in to ChatGPT from the web app works only in a browser on the same computer,
  because Codex receives the answer on a local port.
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
